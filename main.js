const requireEnv = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const api = require('@actual-app/api');
const OAuth = require('oauth');
const readline = require('readline');
const configPath = requireEnv('CONFIG_PATH') || './config.json';
const config = require(configPath);
const OAuth2 = OAuth.OAuth2;    
const sparebank1ClientId = requireEnv('SPAREBANK1_CLIENT_ID');
const sparebank1ClientSecret = requireEnv('SPAREBANK1_CLIENT_SECRET');
const oauth2 = new OAuth2(sparebank1ClientId,
                      sparebank1ClientSecret,
                      'https://api.sparebank1.no/', 
                      'oauth/authorize',
                      'oauth/token',
                      null);
const fs = require('fs');
const options = require('node-options');
const opts = {
  days: 0,
  month: (new Date()).toISOString().substring(0,7),
  account: null,
  verbose: false
};

const log = (...args) => {
  if(opts.verbose) {
    console.error(...args);
  } else {
    return;
  }
};

const saveConfig = async () =>{
  try {
    await fs.promises.writeFile(
      configPath, 
      JSON.stringify(config, null, 2),
      'utf8'
    );
    log(`Saved config to ${configPath}`);
  } catch (error) {
    console.error('Failed to save config:', error);
    throw error;
  }
};

const ask = async (query) => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise(resolve => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
};

// Sparebank1

const sparebank1GetAccessToken = (requestToken, grantType) => {
  log('sparebank1GetAccessToken', grantType);
  return new Promise((resolve, reject) => {
    oauth2.getOAuthAccessToken(
      requestToken,
      { 'grant_type': grantType },
      (error, accessToken, refreshToken, results) => {
        if (error) {
          reject(error);
        } else {
          resolve({ accessToken, refreshToken, results });
        }
      }
    );
  });
}

const sparebank1Auth = async () => {
  console.log('Go here:', oauth2.getAuthorizeUrl({
        client_id: sparebank1ClientId,
        redirect_uri: 'https://auth-helper.herokuapp.com',
        finInst: 'fid-sr-bank',
        state: 'deadbeef',
        response_type: 'code',
    }));
  const code = await ask("Code: ");

  const tokens = await sparebank1GetAccessToken(code, 'authorization_code');
  config.accessToken = tokens.accessToken;
  config.refreshToken = tokens.refreshToken;
  await saveConfig();
};

const sparebank1RefreshToken = async () => {
  log('refreshing token');
  log('old token', config.accessToken.substr(0,150));
  const response = await fetch('https://api.sparebank1.no/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      'client_id': sparebank1ClientId,
      'client_secret': sparebank1ClientSecret,
      'refresh_token': config.refreshToken,
      'grant_type': 'refresh_token'
    })
  });
  const tokens = await response.json();
  log('new token', tokens.access_token.substr(0,150));
  config.accessToken = tokens.access_token;
  config.refreshToken = tokens.refresh_token;
  await saveConfig();
};

const sparebank1Get = async (url, firstAttempt = true) => {
  log('sending sparebank1 GET request', url);
  let authorization = `Bearer ${config.accessToken}`;
  log(authorization);
  let response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': authorization,
      'Accept': 'application/vnd.sparebank1.v1+json; charset=utf-8'
    }
  });

  console.error('response', response.status);

  if (!response.ok) {
    if(response.status === 401 && firstAttempt) {
      await sparebank1RefreshToken();
      return await sparebank1Get(url, false);
    } else {
      log(response);
      log(await response.json());
      throw new Error(`HTTP error! status: ${response.status}`);
    }
  }

  return await response.json();
};

const sparebank1Accounts = async () => {
  log('sparebank1Accounts');
  const accounts = await sparebank1Get('https://api.sparebank1.no/personal/banking/accounts');
  return accounts.accounts;
};

const sparebank1Transactions = async ({ account, startDate, endDate }) => {
  log('sparebank1Transactions');
  log('params', { account, startDate, endDate });
  const url = new URL('https://api.sparebank1.no/personal/banking/transactions');
  url.searchParams.append('accountKey', account.bankKey);
  url.searchParams.append('fromDate', startDate.toISOString().split('T')[0]);
  url.searchParams.append('toDate', endDate.toISOString().split('T')[0]);
  url.searchParams.append('source', 'ALL');
  log('url', url.toString());

  const transactions = await sparebank1Get(url.toString());
  return transactions;
};

// Actual Budget

const makeTransaction = (payees, account) => (bankTx) => {
  const tx = {
    account: account.actualId,
    date: (new Date(bankTx.date)).toLocaleDateString('sv-SE'),
    amount: Math.round(bankTx.amount * 100),
  };

  const remoteAccount = config.accounts[bankTx.remoteAccountNumber];

  if(remoteAccount) {
    const transferPayee = payees.find((p) => p.transfer_acct === remoteAccount.actualId);
    tx.payee = transferPayee.id;
  } else {
    tx.payee_name = bankTx.cleanedDescription;
    tx.imported_payee = bankTx.description;
  }
  return tx;
};

(async () => {
  var parsedOptions = options.parse(process.argv.slice(2), opts);

  log('parsedOptions', parsedOptions);
  log('opts', opts);
  if (parsedOptions.errors) {
    console.error('Unknown argument(s): "' + parsedOptions.errors.join('", "') + '"');
    process.exit(-1);
  }

  let startDate = new Date();
  let endDate = new Date();
  if(opts.days) {
    startDate.setDate(startDate.getDate() - opts.days);
  } else {
    const month = new Date(opts.month);
    startDate = new Date(Date.UTC(month.getFullYear(), month.getMonth(), 1));
    endDate = new Date(Date.UTC(month.getFullYear(), month.getMonth() + 1, 0));
  }
  startDate = startDate;
  endDate = endDate;

  const account = opts.account? config.accounts[opts.account] : null;

  await api.init({
    dataDir: requireEnv('ACTUAL_DATA_DIR'),
    serverURL: requireEnv('ACTUAL_URL'),
    password: requireEnv('ACTUAL_PW'),
  });

  await api.downloadBudget(requireEnv('ACTUAL_BUDGET_ID'));

  switch(parsedOptions.args[0] || 'budget-accounts') {
    case 'budget-accounts':
      console.log(await api.getAccounts());
      break;

    case 'budget-payees':
      console.log(await api.getPayees());
      break;

    case 'import':
      const payees = await api.getPayees();
      if(account) {
        console.error("Importing from", account.name);
        const { transactions } = await sparebank1Transactions({ account, startDate, endDate });
        const actualTransactions = transactions
          .filter(({bookingStatus}) => bookingStatus === 'BOOKED' )
          .map(makeTransaction(payees, account));
        await api.importTransactions(account.actualId, actualTransactions);
      } else {
        for (const [accountNumber, account] of Object.entries(config.accounts)) {
          console.error("Importing from", account.name);
          const { transactions } = await sparebank1Transactions({ account, startDate, endDate });
          const actualTransactions = transactions
            .filter(({bookingStatus}) => bookingStatus === 'BOOKED' )
            .map(makeTransaction(payees, account));
          await api.importTransactions(account.actualId, actualTransactions);
        }
      }
      break;

    case 'bank-auth':
      await sparebank1Auth();
      break;

    case 'bank-accounts':
      const accounts = await sparebank1Accounts();
      console.log(JSON.stringify(accounts, null, 2));
      break;

    case 'bank-transactions':
      if(account) {
        const txs = await sparebank1Transactions({ account, startDate, endDate });
        console.log(JSON.stringify(txs, null, 2));
      } else {
        console.error("No account specified");
        process.exit(-1);
      }
      break;
  }

  await api.shutdown();
})();
