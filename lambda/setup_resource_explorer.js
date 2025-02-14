const { 
  STSClient, 
  AssumeRoleCommand 
} = require('@aws-sdk/client-sts');
const { 
  ResourceExplorer2Client,
  CreateIndexCommand,
  GetIndexCommand,
  UpdateIndexTypeCommand,
  ListIndexesCommand,
  CreateViewCommand,
  AssociateDefaultViewCommand,
  DeleteIndexCommand,
  DeleteViewCommand,
  ListViewsCommand,
  DisassociateDefaultViewCommand
} = require('@aws-sdk/client-resource-explorer-2');
const {
  AccountClient,
  ListRegionsCommand
} = require('@aws-sdk/client-account');
const {
  OrganizationsClient,
  ListAccountsCommand
} = require('@aws-sdk/client-organizations');
const { 
  IAMClient, 
  CreateRoleCommand, 
  PutRolePolicyCommand,
  GetRoleCommand 
} = require('@aws-sdk/client-iam');
const fs = require('fs');
const path = require('path');

async function discoverAccounts() {
  console.log('Starting account discovery');
  const organizations = new OrganizationsClient({ region: 'us-east-1' });
  const accounts = [];
  let nextToken;

  try {
    do {
      const command = new ListAccountsCommand({
        NextToken: nextToken
      });
      const response = await organizations.send(command);
      
      for (const account of response.Accounts) {
        if (account.Status === 'ACTIVE' && account.Id !== process.env.ROOT_ACCOUNT_ID) {
          accounts.push(account.Id);
        }
      }
      
      nextToken = response.NextToken;
    } while (nextToken);

    console.log('Discovered accounts:', accounts);
    return accounts;
  } catch (error) {
    console.error('Error discovering accounts:', error);
    throw error;
  }
}

async function getCredentialsForAccount(accountId) {
  if (!accountId) {
    throw new Error('Account ID is undefined');
  }
  
  console.log(`Getting credentials for account ${accountId}`);
  const sts = new STSClient({ region: 'us-east-1' });
  const assumeRole = await sts.send(new AssumeRoleCommand({
    RoleArn: `arn:aws:iam::${accountId}:role/OrganizationAccountAccessRole`,
    RoleSessionName: 'ResourceExplorerSetup'
  }));

  return {
    accessKeyId: assumeRole.Credentials.AccessKeyId,
    secretAccessKey: assumeRole.Credentials.SecretAccessKey,
    sessionToken: assumeRole.Credentials.SessionToken
  };
}

async function createResourceListerRole(accountId, credentials) {
  console.log(`Setting up P0RoleIamResourceLister in account ${accountId}`);

  const iam = new IAMClient({
    region: 'us-east-1',
    credentials
  });

  try {
    // Check if role exists
    try {
      console.log('Checking if role already exists...');
      await iam.send(new GetRoleCommand({
        RoleName: 'P0RoleIamResourceLister'
      }));
      console.log('Role already exists, will update policy...');
    } catch (error) {
      if (error.name !== 'NoSuchEntityException') {
        throw error;
      }
      // Role doesn't exist, create it
      console.log('Creating P0RoleIamResourceLister role...');
      await iam.send(new CreateRoleCommand({
        RoleName: 'P0RoleIamResourceLister',
        AssumeRolePolicyDocument: JSON.stringify({
          Version: '2012-10-17',
          Statement: [{
            Effect: 'Allow',
            Principal: {
              Federated: 'accounts.google.com'
            },
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: {
              StringEquals: {
                'accounts.google.com:aud': process.env.GOOGLE_AUDIENCE_ID
              }
            }
          }]
        }),
        Tags: [{
          Key: 'P0Security',
          Value: 'Managed by Lambda'
        }]
      }));
    }

    // Read and update policy
    console.log('Reading policy template...');
    const policyPath = path.join(__dirname, 'policies', 'resource_lister_policy.json');
    const policyTemplate = fs.readFileSync(policyPath, 'utf8');
    const policy = policyTemplate.replace(/\$\{account_id\}/g, accountId);

    console.log('Updating role policy...');
    await iam.send(new PutRolePolicyCommand({
      RoleName: 'P0RoleIamResourceLister',
      PolicyName: 'P0RoleIamResourceListerPolicy',
      PolicyDocument: policy
    }));

    console.log('Successfully set up role and policy');
  } catch (error) {
    console.error(`Error setting up role:`, error);
    throw error;
  }
}

async function setupResourceExplorer(accountId, credentials, regions) {
  const summary = {
    accountId,
    activeRegions: regions,
    deployedIndexes: [],
    aggregatorRegion: null,
    defaultView: null,
    errors: []
  };

  console.log(`\n=== Account ${accountId} Setup Summary ===`);
  console.log('Active regions discovered:', regions.join(', '));

  // First check if there's an existing aggregator in any region
  let existingAggregatorRegion = null;
  for (const region of regions) {
    const explorer = new ResourceExplorer2Client({
      region,
      credentials
    });

    try {
      const { Indexes } = await explorer.send(new ListIndexesCommand({}));
      const aggregator = Indexes.find(index => index.Type === 'AGGREGATOR');
      if (aggregator) {
        existingAggregatorRegion = region;
        console.log(`Found existing aggregator in ${region}`);
        summary.aggregatorRegion = region;
        break;
      }
    } catch (error) {
      const errorMsg = `Error checking for aggregator in ${region}: ${error.message}`;
      console.error(errorMsg);
      summary.errors.push(errorMsg);
    }
  }

  // If no aggregator exists, set up us-west-2 as aggregator
  const usw2Region = 'us-west-2';
  const shouldSetupAggregator = !existingAggregatorRegion;
  
  // Setup us-west-2 first since it might be our aggregator
  console.log(`\nSetting up index in ${usw2Region}`);
  const usw2Explorer = new ResourceExplorer2Client({
    region: usw2Region,
    credentials
  });

  try {
    // Create/verify us-west-2 index
    let indexExists = false;
    try {
      const { State } = await usw2Explorer.send(new GetIndexCommand({}));
      if (State === 'ACTIVE') {
        console.log(`Index already exists in ${usw2Region}`);
        indexExists = true;
        summary.deployedIndexes.push(usw2Region);
      }
    } catch (error) {
      if (error.name !== 'ResourceNotFoundException') throw error;
    }

    if (!indexExists) {
      await usw2Explorer.send(new CreateIndexCommand({}));
      console.log(`Created index in ${usw2Region}`);
      summary.deployedIndexes.push(usw2Region);
    }

    // Promote to aggregator if needed
    if (shouldSetupAggregator) {
      console.log('Setting up aggregator in us-west-2...');
      const { Indexes } = await usw2Explorer.send(new ListIndexesCommand({}));
      const currentIndex = Indexes.find(index => index.Region === usw2Region);

      if (currentIndex && currentIndex.Type !== 'AGGREGATOR') {
        try {
          console.log('Promoting index to aggregator...');
          await usw2Explorer.send(new UpdateIndexTypeCommand({
            Arn: currentIndex.Arn,
            Type: 'AGGREGATOR'
          }));
          console.log('Successfully promoted index to aggregator');
          summary.aggregatorRegion = usw2Region;
        } catch (error) {
          const errorMsg = `Error promoting index to aggregator: ${error.message}`;
          if (error.name === 'ServiceQuotaExceededException' || 
              error.message.includes('cool down period')) {
            console.log('Skipping aggregator promotion due to cooldown period');
            summary.errors.push(`${errorMsg} (cooldown period)`);
          } else {
            console.error(errorMsg);
            summary.errors.push(errorMsg);
            throw error;
          }
        }
      }
    }

    // Create and set default view in the aggregator region
    const aggregatorRegion = existingAggregatorRegion || (shouldSetupAggregator ? usw2Region : null);
    if (aggregatorRegion) {
      const aggregatorExplorer = new ResourceExplorer2Client({
        region: aggregatorRegion,
        credentials
      });

      try {
        console.log(`Creating default view in aggregator region ${aggregatorRegion}...`);
        const createViewResponse = await aggregatorExplorer.send(new CreateViewCommand({
          ViewName: 'all-resources-p0',
          Filters: {
            FilterString: ""
          }
        }));

        console.log('Setting as default view...');
        await aggregatorExplorer.send(new AssociateDefaultViewCommand({
          ViewArn: createViewResponse.View.ViewArn
        }));
        console.log('Successfully set default view');
        summary.defaultView = {
          region: aggregatorRegion,
          viewName: 'all-resources-p0',
          viewArn: createViewResponse.View.ViewArn
        };
      } catch (error) {
        if (!error.message.includes('already exists')) {
          const errorMsg = `Error setting up default view: ${error.message}`;
          console.error(errorMsg);
          summary.errors.push(errorMsg);
          throw error;
        }
        console.log('View already exists');
        summary.defaultView = {
          region: aggregatorRegion,
          viewName: 'all-resources-p0',
          status: 'already exists'
        };
      }
    }
  } catch (error) {
    const errorMsg = `Error in ${usw2Region}: ${error.message}`;
    console.error(errorMsg);
    summary.errors.push(errorMsg);
    throw error;
  }

  // Create indexes in other regions
  console.log('\nCreating indexes in other regions...');
  for (const region of regions.filter(r => r !== usw2Region)) {
    console.log(`Processing region ${region}`);
    
    const explorer = new ResourceExplorer2Client({
      region,
      credentials
    });

    try {
      // Check if index exists
      try {
        const { State } = await explorer.send(new GetIndexCommand({}));
        if (State === 'ACTIVE') {
          console.log(`Index already exists in ${region}`);
          summary.deployedIndexes.push(region);
          continue;
        }
      } catch (error) {
        if (error.name !== 'ResourceNotFoundException') {
          const errorMsg = `Error checking index in ${region}: ${error.message}`;
          console.error(errorMsg);
          summary.errors.push(errorMsg);
          continue;
        }
      }

      // Create index
      await explorer.send(new CreateIndexCommand({}));
      console.log(`Created index in ${region}`);
      summary.deployedIndexes.push(region);
    } catch (error) {
      const errorMsg = `Error creating index in ${region}: ${error.message}`;
      console.error(errorMsg);
      summary.errors.push(errorMsg);
    }
  }

  // Print final summary
  console.log('\n=== Final Setup Summary ===');
  console.log(JSON.stringify(summary, null, 2));
  
  return summary;
}

async function cleanupResourceExplorer(accountId, credentials, regions) {
  console.log(`Cleaning up Resource Explorer in account ${accountId}`);

  // Clean up indexes in all regions including us-west-2
  for (const region of regions) {
    console.log(`Cleaning up region ${region}`);
    
    const explorer = new ResourceExplorer2Client({
      region,
      credentials
    });

    try {
      // First disassociate default view if it exists (only in us-west-2)
      if (region === 'us-west-2') {
        try {
          console.log('Disassociating default view...');
          await explorer.send(new DisassociateDefaultViewCommand({}));
        } catch (error) {
          if (!error.name.includes('ResourceNotFoundException')) {
            console.error('Error disassociating default view:', error);
          }
        }
      }

      // List and delete all views
      try {
        const { Views } = await explorer.send(new ListViewsCommand({}));
        for (const view of Views || []) {
          console.log(`Deleting view ${view.ViewName}`);
          await explorer.send(new DeleteViewCommand({
            ViewArn: view.ViewArn
          }));
        }
      } catch (error) {
        console.error(`Error cleaning up views in ${region}:`, error);
      }

      // Delete the index
      try {
        console.log(`Deleting index in ${region}`);
        await explorer.send(new DeleteIndexCommand({}));
      } catch (error) {
        if (!error.name.includes('ResourceNotFoundException')) {
          console.error(`Error deleting index in ${region}:`, error);
        }
      }
    } catch (error) {
      console.error(`Error cleaning up Resource Explorer in ${region}:`, error);
    }
  }
}

exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event));
  
  try {
    // Handle discovery action
    if (event.action === 'discover') {
      console.log('Running account discovery');
      const accounts = await discoverAccounts();
      return { accounts: accounts };
    }

    // Handle destroy action
    if (event.action === 'destroy') {
      console.log('Running cleanup');
      
      // Get list of enabled regions
      const accountClient = new AccountClient({ region: 'us-east-1' });
      const { Regions } = await accountClient.send(new ListRegionsCommand({}));

      const enabledRegions = Regions
        .filter(r => ['ENABLED', 'ENABLING', 'ENABLED_BY_DEFAULT'].includes(r.RegionOptStatus))
        .map(r => r.RegionName);
      
      console.log('Filtered enabled regions:', enabledRegions);
      
      if (!enabledRegions.includes('us-west-2')) {
        enabledRegions.push('us-west-2');
      }

      // Use provided accounts from event
      const accounts = event.accounts || [];
      console.log('Cleaning up accounts:', accounts);

      for (const accountId of accounts) {
        try {
          console.log(`\nCleaning up account ${accountId}`);
          const credentials = await getCredentialsForAccount(accountId);
          await cleanupResourceExplorer(accountId, credentials, enabledRegions);
          console.log(`Successfully cleaned up account ${accountId}`);
        } catch (error) {
          console.error(`Failed to clean up account ${accountId}:`, error);
          throw error;
        }
      }

      return {
        statusCode: 200,
        body: JSON.stringify({
          message: 'Cleanup completed successfully',
          processedAccounts: accounts
        })
      };
    }

    // Regular setup logic
    const setupResults = [];
    console.log('Setup options:', {
      skipAggregator: event.skipAggregator || false,
      skipDefaultView: event.skipDefaultView || false
    });
    
    // Get list of enabled regions
    const accountClient = new AccountClient({ region: 'us-east-1' });
    const { Regions } = await accountClient.send(new ListRegionsCommand({}));
    
    const enabledRegions = Regions
      .filter(r => ['ENABLED', 'ENABLING', 'ENABLED_BY_DEFAULT'].includes(r.RegionOptStatus))
      .map(r => r.RegionName);

    if (!enabledRegions.includes('us-west-2')) {
      enabledRegions.push('us-west-2');
    }

    // Use provided accounts from event
    const accounts = event.accounts || [];
    console.log('Processing accounts:', accounts);

    for (const accountId of accounts) {
      try {
        console.log(`\nProcessing account ${accountId}`);
        
        // Get credentials for member accounts
        let credentials;
        if (accountId !== process.env.ROOT_ACCOUNT_ID) {
          credentials = await getCredentialsForAccount(accountId);
          await createResourceListerRole(accountId, credentials);
        }
        
        const summary = await setupResourceExplorer(
          accountId, 
          credentials,
          enabledRegions
        );
        
        setupResults.push(summary);
        console.log(`Successfully processed account ${accountId}`);
      } catch (error) {
        console.error(`Failed to process account ${accountId}:`, error);
        setupResults.push({
          accountId,
          error: error.message,
          status: 'failed',
          activeRegions: enabledRegions
        });
        throw error;  // Propagate error to ensure Lambda fails
      }
    }

    console.log('\n=== Complete Setup Results ===');
    console.log(JSON.stringify({
      setupResults,
      totalAccounts: accounts.length,
      successfulSetups: setupResults.filter(r => !r.error).length,
      failedSetups: setupResults.filter(r => r.error).length
    }, null, 2));

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Setup completed',
        results: setupResults
      }, null, 2)
    };
  } catch (error) {
    console.error('Lambda execution error:', error);
    throw error;
  }
};
