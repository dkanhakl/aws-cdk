import * as cxapi from '@aws-cdk/cx-api';
import * as aws from 'aws-sdk';
import * as colors from 'colors/safe';
import * as uuid from 'uuid';
import { Tag } from "../api/cxapp/stacks";
import { prepareAssets } from '../assets';
import { debug, error, print } from '../logging';
import { deserializeStructure, toYAML } from '../serialize';
import { Mode } from './aws-auth/credentials';
import { ToolkitInfo } from './toolkit-info';
import { changeSetHasNoChanges, describeStack, stackExists, stackFailedCreating, waitForChangeSet, waitForStack  } from './util/cloudformation';
import { StackActivityMonitor } from './util/cloudformation/stack-activity-monitor';
import { StackStatus } from './util/cloudformation/stack-status';
import { ISDK } from './util/sdk';

type TemplateBodyParameter = {
  TemplateBody?: string
  TemplateURL?: string
};

/** @experimental */
export interface DeployStackResult {
  readonly noOp: boolean;
  readonly outputs: { [name: string]: string };
  readonly stackArn: string;
  readonly stackArtifact: cxapi.CloudFormationStackArtifact;
}

/** @experimental */
export interface DeployStackOptions {
  stack: cxapi.CloudFormationStackArtifact;
  sdk: ISDK;
  toolkitInfo?: ToolkitInfo;
  roleArn?: string;
  notificationArns?: string[];
  deployName?: string;
  quiet?: boolean;
  reuseAssets?: string[];
  tags?: Tag[];

  /**
   * Whether to execute the changeset or leave it in review.
   * @default true
   */
  execute?: boolean;

  /**
   * The collection of extra parameters
   * (in addition to those used for assets)
   * to pass to the deployed template.
   * Note that parameters with `undefined` or empty values will be ignored,
   * and not passed to the template.
   *
   * @default - no additional parameters will be passed to the template
   */
  parameters?: { [name: string]: string | undefined };

  /**
   * Deploy even if the deployed template is identical to the one we are about to deploy.
   * @default false
   */
  force?: boolean;
}

const LARGE_TEMPLATE_SIZE_KB = 50;

/** @experimental */
export async function deployStack(options: DeployStackOptions): Promise<DeployStackResult> {
  if (!options.stack.environment) {
    throw new Error(`The stack ${options.stack.displayName} does not have an environment`);
  }

  const cfn = await options.sdk.cloudFormation(options.stack.environment.account, options.stack.environment.region, Mode.ForWriting);
  const deployName = options.deployName || options.stack.stackName;

  if (!options.force) {
    debug(`checking if we can skip this stack based on the currently deployed template (use --force to override)`);
    const deployed = await getDeployedTemplate(cfn, deployName);
    if (deployed && JSON.stringify(options.stack.template) === JSON.stringify(deployed.template)) {
      debug(`${deployName}: no change in template, skipping (use --force to override)`);
      return {
        noOp: true,
        outputs: await getStackOutputs(cfn, deployName),
        stackArn: deployed.stackId,
        stackArtifact: options.stack
      };
    } else {
      debug(`${deployName}: template changed, deploying...`);
    }
  }

  // bail out if the current template is exactly the same as the one we are about to deploy
  // in cdk-land, this means nothing changed because assets (and therefore nested stacks) are immutable.

  const params = await prepareAssets(options.stack, options.toolkitInfo, options.reuseAssets);

  // add passed CloudFormation parameters
  for (const [paramName, paramValue] of Object.entries((options.parameters || {}))) {
    if (paramValue) {
      params.push({
        ParameterKey: paramName,
        ParameterValue: paramValue,
      });
    }
  }

  const executionId = uuid.v4();

  const bodyParameter = await makeBodyParameter(options.stack, options.toolkitInfo);

  if (await stackFailedCreating(cfn, deployName)) {
    debug(`Found existing stack ${deployName} that had previously failed creation. Deleting it before attempting to re-create it.`);
    await cfn.deleteStack({ StackName: deployName }).promise();
    const deletedStack = await waitForStack(cfn, deployName, false);
    if (deletedStack && deletedStack.StackStatus !== 'DELETE_COMPLETE') {
      throw new Error(`Failed deleting stack ${deployName} that had previously failed creation (current state: ${deletedStack.StackStatus})`);
    }
  }

  const update = await stackExists(cfn, deployName);

  const changeSetName = `CDK-${executionId}`;
  debug(`Attempting to create ChangeSet ${changeSetName} to ${update ? 'update' : 'create'} stack ${deployName}`);
  print(`%s: creating CloudFormation changeset...`, colors.bold(deployName));
  const changeSet = await cfn.createChangeSet({
    StackName: deployName,
    ChangeSetName: changeSetName,
    ChangeSetType: update ? 'UPDATE' : 'CREATE',
    Description: `CDK Changeset for execution ${executionId}`,
    TemplateBody: bodyParameter.TemplateBody,
    TemplateURL: bodyParameter.TemplateURL,
    Parameters: params,
    RoleARN: options.roleArn,
    NotificationARNs: options.notificationArns,
    Capabilities: [ 'CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND' ],
    Tags: options.tags
  }).promise();
  debug('Initiated creation of changeset: %s; waiting for it to finish creating...', changeSet.Id);
  const changeSetDescription = await waitForChangeSet(cfn, deployName, changeSetName);

  if (changeSetHasNoChanges(changeSetDescription)) {
    debug('No changes are to be performed on %s.', deployName);
    await cfn.deleteChangeSet({ StackName: deployName, ChangeSetName: changeSetName }).promise();
    return { noOp: true, outputs: await getStackOutputs(cfn, deployName), stackArn: changeSet.StackId!, stackArtifact: options.stack };
  }

  const execute = options.execute === undefined ? true : options.execute;
  if (execute) {
    debug('Initiating execution of changeset %s on stack %s', changeSetName, deployName);
    await cfn.executeChangeSet({StackName: deployName, ChangeSetName: changeSetName}).promise();
    // tslint:disable-next-line:max-line-length
    const monitor = options.quiet ? undefined : new StackActivityMonitor(cfn, deployName, options.stack, (changeSetDescription.Changes || []).length).start();
    debug('Execution of changeset %s on stack %s has started; waiting for the update to complete...', changeSetName, deployName);
    await waitForStack(cfn, deployName);
    if (monitor) {
      await monitor.stop();
    }
    debug('Stack %s has completed updating', deployName);
  } else {
    print(`Changeset %s created and waiting in review for manual execution (--no-execute)`, changeSetName);
  }
  return { noOp: false, outputs: await getStackOutputs(cfn, deployName), stackArn: changeSet.StackId!, stackArtifact: options.stack };
}

/** @experimental */
async function getStackOutputs(cfn: aws.CloudFormation, stackName: string): Promise<{ [name: string]: string }> {
  const description = await describeStack(cfn, stackName);
  const result: { [name: string]: string } = {};
  if (description && description.Outputs) {
    description.Outputs.forEach(output => {
      result[output.OutputKey!] = output.OutputValue!;
    });
  }
  return result;
}

/**
 * Prepares the body parameter for +CreateChangeSet+, putting the generated CloudFormation template in the toolkit-provided
 * S3 bucket if present, otherwise using in-line template argument. If no +ToolkitInfo+ is provided and the template is
 * larger than 50,200 bytes, an +Error+ will be raised.
 *
 * @param stack     the synthesized stack that provides the CloudFormation template
 * @param sdk     an AWS SDK to use when interacting with S3
 * @param toolkitInfo information about the toolkit stack
 */
async function makeBodyParameter(stack: cxapi.CloudFormationStackArtifact, toolkitInfo?: ToolkitInfo): Promise<TemplateBodyParameter> {
  const templateJson = toYAML(stack.template);
  if (toolkitInfo) {
    const s3KeyPrefix = `cdk/${stack.id}/`;
    const s3KeySuffix = '.yml';
    const { key } = await toolkitInfo.uploadIfChanged(templateJson, {
      s3KeyPrefix, s3KeySuffix, contentType: 'application/x-yaml'
    });
    const templateURL = `${toolkitInfo.bucketUrl}/${key}`;
    debug('Stored template in S3 at:', templateURL);
    return { TemplateURL: templateURL };
  } else if (templateJson.length > LARGE_TEMPLATE_SIZE_KB * 1024) {
    error(
      `The template for stack "${stack.displayName}" is ${Math.round(templateJson.length / 1024)}KiB. ` +
      `Templates larger than ${LARGE_TEMPLATE_SIZE_KB}KiB must be uploaded to S3.\n` +
      'Run the following command in order to setup an S3 bucket in this environment, and then re-deploy:\n\n',
      colors.blue(`\t$ cdk bootstrap ${stack.environment!.name}\n`));

    throw new Error(`Template too large to deploy ("cdk bootstrap" is required)`);
  } else {
    return { TemplateBody: templateJson };
  }
}

/** @experimental */
export interface DestroyStackOptions {
  stack: cxapi.CloudFormationStackArtifact;
  sdk: ISDK;
  roleArn?: string;
  deployName?: string;
  quiet?: boolean;
}

/** @experimental */
export async function destroyStack(options: DestroyStackOptions) {
  if (!options.stack.environment) {
    throw new Error(`The stack ${options.stack.displayName} does not have an environment`);
  }

  const deployName = options.deployName || options.stack.stackName;
  const cfn = await options.sdk.cloudFormation(options.stack.environment.account, options.stack.environment.region, Mode.ForWriting);
  if (!await stackExists(cfn, deployName)) {
    return;
  }
  const monitor = options.quiet ? undefined : new StackActivityMonitor(cfn, deployName, options.stack).start();
  await cfn.deleteStack({ StackName: deployName, RoleARN: options.roleArn }).promise().catch(e => { throw e; });
  const destroyedStack = await waitForStack(cfn, deployName, false);
  if (monitor) { await monitor.stop(); }
  if (destroyedStack && destroyedStack.StackStatus !== 'DELETE_COMPLETE') {
    const status = StackStatus.fromStackDescription(destroyedStack);
    throw new Error(`Failed to destroy ${deployName}: ${status}`);
  }
  return;
}

async function getDeployedTemplate(cfn: aws.CloudFormation, stackName: string): Promise<{ template: any, stackId: string } | undefined> {
  const stackId = await getStackId(cfn, stackName);
  if (!stackId) {
    return undefined;
  }

  const template = await readCurrentTemplate(cfn, stackName);
  return { stackId, template };
}

export async function readCurrentTemplate(cfn: aws.CloudFormation, stackName: string) {
  try {
    const response = await cfn.getTemplate({ StackName: stackName, TemplateStage: 'Original' }).promise();
    return (response.TemplateBody && deserializeStructure(response.TemplateBody)) || {};
  } catch (e) {
    if (e.code === 'ValidationError' && e.message === `Stack with id ${stackName} does not exist`) {
      return {};
    } else {
      throw e;
    }
  }
}

async function getStackId(cfn: aws.CloudFormation, stackName: string): Promise<string | undefined> {
  try {
    const stacks = await cfn.describeStacks({ StackName: stackName }).promise();
    if (!stacks.Stacks) {
      return undefined;
    }
    if (stacks.Stacks.length !== 1) {
      return undefined;
    }

    return stacks.Stacks[0].StackId!;

  } catch (e) {
    if (e.message.includes('does not exist')) {
      return undefined;
    }
    throw e;
  }
}