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
  AssociateDefaultViewCommand
} = require('@aws-sdk/client-resource-explorer-2');
const {
  AccountClient,
  ListRegionsCommand
} = require('@aws-sdk/client-account');
const { 
  IAMClient, 
  CreateRoleCommand, 
  PutRolePolicyCommand,
  GetRoleCommand 
} = require('@aws-sdk/client-iam');
const fs = require('fs');
const path = require('path');

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
  // First set up us-west-2 as it will be the aggregator
  const usw2Region = 'us-west-2';
  console.log(`Setting up index in ${usw2Region}`);
  
  const usw2Explorer = new ResourceExplorer2Client({
    region: usw2Region,
    credentials
  });

  // Create/verify us-west-2 index
  try {
    let indexExists = false;
    try {
      const { State } = await usw2Explorer.send(new GetIndexCommand({}));
      if (State === 'ACTIVE') {
        console.log(`Index already exists in ${usw2Region}`);
        indexExists = true;
      }
    } catch (error) {
      if (error.name !== 'ResourceNotFoundException') throw error;
    }

    if (!indexExists) {
      await usw2Explorer.send(new CreateIndexCommand({}));
      console.log(`Created index in ${usw2Region}`);
      
      // Wait for index to be active
      let indexState = '';
      while (indexState !== 'ACTIVE') {
        const { State } = await usw2Explorer.send(new GetIndexCommand({}));
        indexState = State;
        if (indexState !== 'ACTIVE') {
          console.log(`Waiting for index to be active... Current state: ${indexState}`);
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
    }

    // Check for existing aggregator
    console.log('Checking for existing aggregator...');
    const { Indexes } = await usw2Explorer.send(new ListIndexesCommand({}));
    const hasAggregator = Indexes.some(index => index.Type === 'AGGREGATOR');
    const currentIndex = Indexes.find(index => index.Region === usw2Region);

    if (!hasAggregator && currentIndex) {
      try {
        console.log('Promoting index to aggregator...');
        await usw2Explorer.send(new UpdateIndexTypeCommand({
          Arn: currentIndex.Arn,
          Type: 'AGGREGATOR'
        }));
        console.log('Successfully promoted index to aggregator');
      } catch (error) {
        if (error.name === 'ServiceQuotaExceededException' || 
            error.message.includes('cool down period')) {
          console.log('Skipping aggregator promotion due to cooldown period');
        } else {
          throw error;
        }
      }
    }

    // Create and set default view
    try {
      console.log('Creating default view...');
      const createViewResponse = await usw2Explorer.send(new CreateViewCommand({
        ViewName: 'all-resources-p0',
        Filters: {
          FilterString: ""
        }
      }));

      console.log('Setting as default view...');
      await usw2Explorer.send(new AssociateDefaultViewCommand({
        ViewArn: createViewResponse.View.ViewArn
      }));
      console.log('Successfully set default view');
    } catch (error) {
      if (!error.message.includes('already exists')) {
        throw error;
      }
      console.log('View already exists');
    }
  } catch (error) {
    console.error(`Error setting up aggregator in ${usw2Region}:`, error);
    throw error;
  }

  // Create indexes in other regions
  console.log('Creating indexes in other regions...');
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
          continue;
        }
      } catch (error) {
        if (error.name !== 'ResourceNotFoundException') {
          console.error(`Error checking index in ${region}:`, error);
          continue;
        }
      }

      // Create index
      await explorer.send(new CreateIndexCommand({}));
      console.log(`Created index in ${region}`);
    } catch (error) {
      console.error(`Error creating index in ${region}:`, error);
    }
  }
}

async function setupResourceExplorer(accountId, credentials, regions, skipAggregator = false) {
  // First set up us-west-2 as it will be the aggregator
  const usw2Region = 'us-west-2';
  console.log(`Setting up index in ${usw2Region}`);
  
  const usw2Explorer = new ResourceExplorer2Client({
    region: usw2Region,
    credentials
  });

  // Create/verify us-west-2 index
  try {
    let indexExists = false;
    try {
      const { State } = await usw2Explorer.send(new GetIndexCommand({}));
      if (State === 'ACTIVE') {
        console.log(`Index already exists in ${usw2Region}`);
        indexExists = true;
      }
    } catch (error) {
      if (error.name !== 'ResourceNotFoundException') throw error;
    }

    if (!indexExists) {
      await usw2Explorer.send(new CreateIndexCommand({}));
      console.log(`Created index in ${usw2Region}`);
    }

    // Only attempt aggregator setup if not skipped
    if (!skipAggregator) {
      // Check for existing aggregator
      console.log('Checking for existing aggregator...');
      const { Indexes } = await usw2Explorer.send(new ListIndexesCommand({}));
      const hasAggregator = Indexes.some(index => index.Type === 'AGGREGATOR');
      const currentIndex = Indexes.find(index => index.Region === usw2Region);

      if (!hasAggregator && currentIndex) {
        try {
          console.log('Promoting index to aggregator...');
          await usw2Explorer.send(new UpdateIndexTypeCommand({
            Arn: currentIndex.Arn,
            Type: 'AGGREGATOR'
          }));
          console.log('Successfully promoted index to aggregator');

          // Create and set default view
          try {
            console.log('Creating default view...');
            const createViewResponse = await usw2Explorer.send(new CreateViewCommand({
              ViewName: 'all-resources-p0',
              Filters: {
                FilterString: ""
              }
            }));

            console.log('Setting as default view...');
            await usw2Explorer.send(new AssociateDefaultViewCommand({
              ViewArn: createViewResponse.View.ViewArn
            }));
            console.log('Successfully set default view');
          } catch (error) {
            if (!error.message.includes('already exists')) {
              throw error;
            }
            console.log('View already exists');
          }
        } catch (error) {
          if (error.name === 'ServiceQuotaExceededException' || 
              error.message.includes('cool down period')) {
            console.log('Skipping aggregator promotion due to cooldown period');
          } else {
            throw error;
          }
        }
      } else {
        console.log('Aggregator already exists or index not found');
      }
    } else {
      console.log('Skipping aggregator setup as requested');
    }
  } catch (error) {
    console.error(`Error in ${usw2Region}:`, error);
    throw error;
  }

  // Create indexes in other regions
  console.log('Creating indexes in other regions...');
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
          continue;
        }
      } catch (error) {
        if (error.name !== 'ResourceNotFoundException') {
          console.error(`Error checking index in ${region}:`, error);
          continue;
        }
      }

      // Create index
      await explorer.send(new CreateIndexCommand({}));
      console.log(`Created index in ${region}`);
    } catch (error) {
      console.error(`Error creating index in ${region}:`, error);
    }
  }
}

exports.handler = async (event) => {
  try {
    // Check if we should skip aggregator setup
    const skipAggregator = event?.skipAggregator || false;
    console.log(skipAggregator ? 'Will skip aggregator setup' : 'Will setup aggregator');

    // Get list of enabled regions
    const accountClient = new AccountClient({ region: 'us-east-1' });
    const { Regions } = await accountClient.send(new ListRegionsCommand({}));
    
    console.log('All regions and their status:', JSON.stringify(Regions, null, 2));
    
    const enabledRegions = Regions
      .filter(r => r.RegionOptStatus === 'ENABLED' || r.RegionOptStatus === 'ENABLING')
      .map(r => r.RegionName);

    console.log('Processing explicitly enabled regions:', enabledRegions);
    
    if (!enabledRegions.includes('us-west-2')) {
      console.log('Adding us-west-2 as it is required for the aggregator');
      enabledRegions.push('us-west-2');
    }

    if (enabledRegions.length === 0) {
      console.error('No enabled regions found! This is unexpected.');
      enabledRegions.push('us-west-2');
    }

    // Process member accounts
    const memberAccounts = JSON.parse(process.env.MEMBER_ACCOUNTS || '[]');
    console.log('Processing member accounts:', memberAccounts);

    for (const accountId of memberAccounts) {
      try {
        console.log(`\nProcessing account ${accountId}`);
        const credentials = await getCredentialsForAccount(accountId);
        
        // Create role and policy
        await createResourceListerRole(accountId, credentials);
        
        // Set up Resource Explorer
        await setupResourceExplorer(accountId, credentials, enabledRegions, skipAggregator);
        
        console.log(`Successfully processed account ${accountId}`);
      } catch (error) {
        console.error(`Failed to process account ${accountId}:`, error);
        // Continue with next account
      }
    }

    return {
      statusCode: 200,
      body: 'Setup completed successfully'
    };
  } catch (error) {
    console.error('Lambda execution error:', error);
    throw error;
  }
};
  try {
// Get list of enabled regions
    const accountClient = new AccountClient({ region: 'us-east-1' });
    const { Regions } = await accountClient.send(new ListRegionsCommand({}));
    
    console.log('All regions and their status:', JSON.stringify(Regions, null, 2));
    
    const enabledRegions = Regions
      .filter(r => r.RegionOptStatus === 'ENABLED' || r.RegionOptStatus === 'ENABLING')
      .map(r => r.RegionName);

    console.log('Processing explicitly enabled regions:', enabledRegions);
    
    if (!enabledRegions.includes('us-west-2')) {
      console.log('Adding us-west-2 as it is required for the aggregator');
      enabledRegions.push('us-west-2');
    }

    if (enabledRegions.length === 0) {
      console.error('No enabled regions found! This is unexpected.');
      enabledRegions.push('us-west-2');
    }

    // Process member accounts
    const memberAccounts = JSON.parse(process.env.MEMBER_ACCOUNTS || '[]');
    console.log('Processing member accounts:', memberAccounts);

    for (const accountId of memberAccounts) {
      try {
        console.log(`\nProcessing account ${accountId}`);
        const credentials = await getCredentialsForAccount(accountId);
        
        // Create role and policy
        await createResourceListerRole(accountId, credentials);
        
        // Set up Resource Explorer
        await setupResourceExplorer(accountId, credentials, enabledRegions);
        
        console.log(`Successfully processed account ${accountId}`);
      } catch (error) {
        console.error(`Failed to process account ${accountId}:`, error);
        // Continue with next account
      }
    }

    return {
      statusCode: 200,
      body: 'Setup completed successfully'
    };
  } catch (error) {
    console.error('Lambda execution error:', error);
    throw error;
  }
};