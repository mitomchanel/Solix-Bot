const fs = require("fs");
const fsPromises = require("fs/promises");

const path = require("path");
const axios = require("axios");
const colors = require("colors");
const { HttpsProxyAgent } = require("https-proxy-agent");
const readline = require("readline");
const user_agents = require("./config/userAgents.js");
const settings = require("./config/config.js");
const { sleep, loadData, getRandomNumber, saveToken, isTokenExpired, saveJson, getRandomElement, generateRandomNumber } = require("./utils.js");
const { checkBaseUrl } = require("./checkAPI");
const { Wallet, ethers } = require("ethers");
const { jwtDecode } = require("jwt-decode");
const { v4: uuidv4 } = require("uuid");
const { Keypair } = require("@solana/web3.js");
const nacl = require("tweetnacl");
const bs58 = require("bs58");
const cpus = require("./core/CPU.js");
const { sovleCaptcha } = require("./captcha.js");
let intervalIds = [];

function getWalletFromPrivateKey(privateKeyBase58) {
  const secretKey = bs58.decode(privateKeyBase58);
  const keypair = Keypair.fromSecretKey(secretKey);
  return keypair;
}

class ClientAPI {
  constructor(itemData, accountIndex, proxy, baseURL, localStorage) {
    this.extensionId = "chrome-extension://lhmminnoafalclkgcbokfcngkocoffcp";
    this.headers = {
      Accept: "*/*",
      "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "none",
      origin: "https://dashboard.solixdepin.net",
      referer: "https://dashboard.solixdepin.net/",
      host: "api.solixdepin.net",
      connection: "keep-alive",
      "content-type": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
    };
    this.baseURL = baseURL;
    this.baseURL_v2 = settings.BASE_URL_v2;

    this.itemData = itemData;
    this.accountIndex = accountIndex;
    this.proxy = proxy;
    this.proxyIP = null;
    this.session_name = null;
    this.session_user_agents = this.#load_session_data();
    this.token = null;
    this.authInfo = null;
    this.localStorage = localStorage;
    // this.wallet = getWalletFromPrivateKey(itemData.privateKey);
  }

  #load_session_data() {
    try {
      const filePath = path.join(process.cwd(), "session_user_agents.json");
      const data = fs.readFileSync(filePath, "utf8");
      return JSON.parse(data);
    } catch (error) {
      if (error.code === "ENOENT") {
        return {};
      } else {
        throw error;
      }
    }
  }

  #get_random_user_agent() {
    const randomIndex = Math.floor(Math.random() * user_agents.length);
    return user_agents[randomIndex];
  }

  #get_user_agent() {
    if (this.session_user_agents[this.session_name]) {
      return this.session_user_agents[this.session_name];
    }

    console.log(`[Tài khoản ${this.accountIndex + 1}] Tạo user agent...`.blue);
    const newUserAgent = this.#get_random_user_agent();
    this.session_user_agents[this.session_name] = newUserAgent;
    this.#save_session_data(this.session_user_agents);
    return newUserAgent;
  }

  #save_session_data(session_user_agents) {
    const filePath = path.join(process.cwd(), "session_user_agents.json");
    fs.writeFileSync(filePath, JSON.stringify(session_user_agents, null, 2));
  }

  #get_platform(userAgent) {
    const platformPatterns = [
      { pattern: /iPhone/i, platform: "ios" },
      { pattern: /Android/i, platform: "android" },
      { pattern: /iPad/i, platform: "ios" },
    ];

    for (const { pattern, platform } of platformPatterns) {
      if (pattern.test(userAgent)) {
        return platform;
      }
    }

    return "Unknown";
  }

  #set_headers() {
    const platform = this.#get_platform(this.#get_user_agent());
    this.headers["sec-ch-ua"] = `Not)A;Brand";v="99", "${platform} WebView";v="127", "Chromium";v="127`;
    this.headers["sec-ch-ua-platform"] = platform;
    this.headers["User-Agent"] = this.#get_user_agent();
  }

  createUserAgent() {
    try {
      this.session_name = this.itemData.email;
      this.#get_user_agent();
    } catch (error) {
      this.log(`Can't create user agent: ${error.message}`, "error");
      return;
    }
  }

  async log(msg, type = "info") {
    const accountPrefix = `[Solix][Account ${this.accountIndex + 1}][${this.itemData.email}]`;
    let ipPrefix = "[Local IP]";
    if (settings.USE_PROXY) {
      ipPrefix = this.proxyIP ? `[${this.proxyIP}]` : "[Unknown IP]";
    }
    let logMessage = "";

    switch (type) {
      case "success":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.green;
        break;
      case "error":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.red;
        break;
      case "warning":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.yellow;
        break;
      case "custom":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.magenta;
        break;
      default:
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.blue;
    }
    console.log(logMessage);
  }

  async checkProxyIP() {
    try {
      const proxyAgent = new HttpsProxyAgent(this.proxy);
      const response = await axios.get("https://api.ipify.org?format=json", { httpsAgent: proxyAgent });
      if (response.status === 200) {
        this.proxyIP = response.data.ip;
        return response.data.ip;
      } else {
        throw new Error(`Cannot check proxy IP. Status code: ${response.status}`);
      }
    } catch (error) {
      throw new Error(`Error checking proxy IP: ${error.message}`);
    }
  }

  async makeRequest(
    url,
    method,
    data = {},
    options = {
      retries: 2,
      isAuth: false,
      extraHeaders: {},
      refreshToken: null,
    }
  ) {
    const { retries, isAuth, extraHeaders, refreshToken } = options;

    const headers = {
      ...this.headers,
      ...extraHeaders,
    };

    if (!isAuth) {
      headers["authorization"] = `Bearer ${this.token}`;
    }

    if (refreshToken) {
      headers["authorization"] = `Bearer ${refreshToken}`;
    }

    let proxyAgent = null;
    if (settings.USE_PROXY) {
      proxyAgent = new HttpsProxyAgent(this.proxy);
    }
    let currRetries = 0,
      errorMessage = null,
      errorStatus = 0;

    do {
      try {
        const response = await axios({
          method,
          url,
          headers,
          timeout: 120000,
          ...(proxyAgent ? { httpsAgent: proxyAgent, httpAgent: proxyAgent } : {}),
          ...(method.toLowerCase() != "get" ? { data } : {}),
        });
        if (response?.data?.data) return { status: response.status, success: true, data: response.data.data, error: null };
        return { success: true, data: response.data, status: response.status, error: null };
      } catch (error) {
        errorStatus = error.status;
        errorMessage = error?.response?.data?.message ? error?.response?.data : error.message;
        this.log(`Request failed: ${url} | Status: ${error.status} | ${JSON.stringify(errorMessage || {})}...`, "warning");

        if (error.status == 401) {
          this.log(`Unauthorized: ${url} | trying get new token...`);
          this.token = await this.getValidToken(true);
          return await this.makeRequest(url, method, data, options);
        }
        if (error.status == 400) {
          this.log(`Invalid request for ${url}, maybe have new update from server`, "error");
          return { success: false, status: error.status, error: errorMessage, data: null };
        }
        if (error.status == 429) {
          this.log(`Rate limit ${JSON.stringify(errorMessage)}, waiting 60s to retries`, "warning");
          await sleep(60);
        }
        if (currRetries > retries) {
          return { status: error.status, success: false, error: errorMessage, data: null };
        }
        currRetries++;
        await sleep(5);
      }
    } while (currRetries <= retries);
    return { status: errorStatus, success: false, error: errorMessage, data: null };
  }

  // async auth() {
  //   const message = "Please sign this message to connect your wallet to Flow 3 and verifying your ownership only.";
  //   const messageBuffer = Buffer.from(message);
  //   const secretKey = new Uint8Array(this.itemData.secretKey);
  //   const signature = nacl.sign.detached(messageBuffer, secretKey);
  //   const signatureBase58 = bs58.encode(signature);
  //   const payload = {
  //     message: message,
  //     walletAddress: this.itemData.address,
  //     signature: signatureBase58,
  //     referralCode: settings.REF_CODE,
  //   };
  //   return this.makeRequest(`${this.baseURL}/user/login`, "post", payload, { isAuth: true });
  // }

  async login() {
    // const captchaToken = await sovleCaptcha();
    // if (!captchaToken) {
    //   this.log(`Can't get captcha token...`, "error");
    //   await sleep(1);
    //   process.exit(1);
    // }
    const payload = {
      email: this.itemData.email,
      password: this.itemData.password,
    };
    return this.makeRequest(`${this.baseURL}/auth/login-password`, "post", payload, { isAuth: true });
  }

  async hb() {
    return this.makeRequest(`${this.baseURL}/bandwidth`, "post", null, {
      extraHeaders: {
        Origin: "chrome-extension://lhmminnoafalclkgcbokfcngkocoffcp",
      },
    });
  }

  async getRefereshToken() {
    return this.makeRequest(
      `${this.baseURL}/auth/refresh`,
      "post",
      {
        refreshToken: this.authInfo.refreshToken,
      },
      {
        refreshToken: this.authInfo.refreshToken,
      }
    );
  }

  async getBalance() {
    return this.makeRequest(`${this.baseURL}/point/get-total-point`, "get");
  }

  async getConnectQuality() {
    return this.makeRequest(`${this.baseURL}/point/get-connection-quality`, "get");
  }

  async getUserData() {
    return this.makeRequest(`${this.baseURL}/auth/profile`, "get");
  }

  async getTasks() {
    return this.makeRequest(`${this.baseURL}/task/get-user-task`, "get");
  }

  async getDailyTasks() {
    return this.makeRequest(`${this.baseURL}/task/get-user-task-daily`, "get");
  }

  async compleTask(id) {
    return this.makeRequest(`${this.baseURL}/task/do-task`, "post", { taskId: id });
  }

  async claimTask(id) {
    return this.makeRequest(`${this.baseURL}/task/claim-task`, "post", { taskId: id });
  }

  async checkin(id) {
    return this.makeRequest(`${this.baseURL}/task/daily-check-in`, "post", { taskId: id });
  }

  async getValidToken(isNew = false) {
    const existingToken = this.token;
    const { isExpired: isExp, expirationDate } = isTokenExpired(existingToken);

    this.log(`Access token status: ${isExp ? "Expired".yellow : "Valid".green} | Acess token exp: ${expirationDate}`);
    if (existingToken && !isNew && !isExp) {
      this.log("Using valid token", "success");
      return existingToken;
    }

    if (this.authInfo?.refreshToken) {
      const { isExpired: isExpRe, expirationDate: expirationDateRe } = isTokenExpired(this.authInfo.refreshToken);
      this.log(`RefereshToken token status: ${isExpRe ? "Expired".yellow : "Valid".green} | RefereshToken token exp: ${expirationDateRe}`);
      if (!isExpRe) {
        const result = await this.getRefereshToken();
        if (result.data?.accessToken) {
          await saveJson(this.session_name, JSON.stringify(result.data), "localStorage.json");
          return result.data.accessToken;
        }
      }
    }

    this.log("No found token or experied, logining......", "warning");
    const loginRes = await this.login();
    if (!loginRes?.success) return null;
    const newToken = loginRes.data;
    if (newToken?.accessToken) {
      await saveJson(this.session_name, JSON.stringify(newToken), "localStorage.json");
      return newToken.accessToken;
    }
    this.log("Can't get new token...", "warning");
    return null;
  }

  async handleCheckPoint() {
    const balanceData = await this.getBalance();
    if (!balanceData.success) return this.log(`Can't sync new points...`, "warning");
    const { totalPointEarned, todayPointEarned } = balanceData.data;
    this.log(`${new Date().toLocaleString()} Earning today: ${totalPointEarned.toFixed(2)} | Total points: ${todayPointEarned.toFixed(2)} | Recheck after 5 minutes`, "custom");
  }

  async checkInvaliable(date) {
    const latestCheckin = new Date(date);
    const currentDate = new Date();

    // Tính khoảng thời gian đã trôi qua tính bằng giờ
    const hoursDiff = (currentDate - latestCheckin) / (1000 * 60 * 60);

    return hoursDiff > 24; // Trả về true nếu đã qua 24 tiếng
  }

  async handleCheckin() {
    this.log(`Get checkin status...`);

    const dailytasksData = await this.getDailyTasks();
    if (!dailytasksData.success) return this.log("Can't get daily tasks...", "warning");
    const today = dailytasksData.data.find((i) => i.status == "idle");

    if (today) {
      const resCheckin = await this.checkin(today._id);
      if (resCheckin.data?.result == "success") this.log(`${today.name} success | Reward: ${today.pointAmount || 0}`, "success");
      else {
        this.log(`Can't checkin | ${JSON.stringify(resCheckin)}`, "warning");
      }
    }
    this.authInfo["latestCheckin"] = new Date();
    await saveJson(this.session_name, JSON.stringify(this.authInfo), "localStorage.json");
  }

  async handleTasks() {
    this.log(`Checking tasks...`);
    let tasks = [];
    const tasksData = await this.getTasks();

    if (!tasksData.success) {
      this.log("Can't get tasks...", "warning");
      return;
    }

    const tasksToComplete = tasksData.data.filter((task) => task.status != "claimed" && !settings.SKIP_TASKS.includes(task._id));

    if (tasksToComplete.length == 0) return this.log(`No tasks avaliable to do!`, "warning");
    for (const task of tasksToComplete) {
      let { _id: taskId, name: title, status } = task;
      const timeSleep = getRandomNumber(settings.DELAY_BETWEEN_REQUESTS[0], settings.DELAY_BETWEEN_REQUESTS[1]);
      this.log(`Completing task: ${taskId} | ${title} | Waiting: ${timeSleep}s...`);
      const compleRes = await this.compleTask(taskId);
      if (compleRes.data?.result == "success") {
        this.log(`Task ${taskId} | ${title} complete successfully! | Reward: ${task.pointAmount}`, "success");
        status = "pending";
      } else {
        this.log(`Can't complete task ${taskId} | ${title} | ${JSON.stringify(compleRes)}...`, "warning");
      }
      await sleep(3);
      if (status == "pending") {
        const claimRes = await this.claimTask(taskId);
        if (claimRes.data?.result == "success") {
          this.log(`Task ${taskId} | ${title} claimed successfully! | Reward: ${task.pointAmount}`, "success");
        } else {
          this.log(`Can't claim task ${taskId} | ${title} | ${JSON.stringify(claimRes)}...`, "warning");
        }
      }
    }
  }

  async handleSyncData() {
    this.log(`Sync data...`);
    let userData = { success: true, data: null, status: 0, error: null },
      retries = 0;

    do {
      userData = await this.getUserData();
      if (userData?.success) break;
      retries++;
    } while (retries < 1 && userData.status !== 400);
    const balanceData = await this.getBalance();
    if (userData.success && balanceData.success) {
      const { referralCode, email, isEarning } = userData.data;
      const { totalPointEarned, todayPointEarned } = balanceData.data;

      this.log(`Ref code: ${referralCode} | Earning today: ${todayPointEarned.toFixed(2)} | Total points: ${totalPointEarned.toFixed(2)}`, "custom");

      // if (!walletAddress) {
      //   this.log(`Wallet address not set! | Trying to set...`, "warning");
      //   const payload = {
      //     walletAddress: this.itemData.address,
      //   };
      //   const resSetWallet = await this.makeRequest(`${this.baseURL}/user/update-wallet-address`, "post", payload);
      //   if (resSetWallet.success) {
      //     this.log(`Wallet address set successfully! | ${this.itemData.address}`, "success");
      //     userData.data.walletAddress = this.itemData.address;
      //   } else {
      //     this.log(`Can't set wallet address | ${JSON.stringify(resSetWallet)}`, "warning");
      //   }
      // }
    } else {
      return this.log("Can't sync new data...skipping", "warning");
    }
    return userData;
  }

  async handleHB() {
    const result = await this.getConnectQuality();
    if (result?.success) {
      this.log(`[${new Date().toLocaleString()}][Connect quality: ${result.data}%] Ping success!`, "success");
    } else {
      this.log(`[${new Date().toLocaleString()}] Ping failed! | ${JSON.stringify(result || {})}`, "warning");
    }
  }

  async runAccount() {
    this.session_name = this.itemData.email;
    this.authInfo = JSON.parse(this.localStorage[this.session_name] || "{}");
    this.token = this.authInfo?.token;
    this.#set_headers();
    if (settings.USE_PROXY) {
      try {
        this.proxyIP = await this.checkProxyIP();
      } catch (error) {
        this.log(`Cannot check proxy IP: ${error.message}`, "warning");
        return;
      }
      const timesleep = getRandomNumber(settings.DELAY_START_BOT[0], settings.DELAY_START_BOT[1]);
      this.log(`Bắt đầu sau ${timesleep} giây...`);
      await sleep(timesleep);
    }

    const token = await this.getValidToken();
    if (!token) return;
    this.token = token;
    const userData = await this.handleSyncData();
    await sleep(1);
    if (userData?.success) {
      // if (!this.authInfo?.latestCheckin || (await this.checkInvaliable(this.authInfo?.latestCheckin))) {
      //   await this.handleCheckin();
      //   await sleep(1);
      // } else {
      //   this.log(`Your checked in today! | Latest checkin: ${new Date(this.authInfo?.latestCheckin).toLocaleString()}`, "warning");
      // }
      const interValCheckPoint = setInterval(() => this.handleCheckPoint(), 5 * 60 * 1000);
      intervalIds.push(interValCheckPoint);
      if (settings.AUTO_TASK) {
        await this.handleTasks();
      }
      if (settings.AUTO_MINING) {
        await this.handleHB();
        const interValHB = setInterval(() => this.handleHB(), settings.PING_INTERVAL * 1000);
        intervalIds.push(interValHB);
      }
    } else {
      this.log("Can't get user info...skipping", "error");
    }
  }
}

function stopInterVal() {
  if (intervalIds.length > 0) {
    for (const intervalId of intervalIds) {
      clearInterval(intervalId);
    }
    intervalIds = [];
  }
}

async function main() {
  console.log(colors.yellow("Solix Bot"));

  const data = [];
  // loadData("privateKeys.txt");
  const accounts = loadData("accounts.txt");
  const proxies = loadData("proxy.txt");
  let localStorage = JSON.parse(fs.readFileSync("localStorage.json", "utf8"));

  if (accounts.length == 0 || (accounts.length > proxies.length && settings.USE_PROXY)) {
    console.log("Số lượng proxy và accounts phải bằng nhau.".red);
    console.log(`Data: ${accounts.length}`);
    console.log(`Proxy: ${proxies.length}`);
    process.exit(1);
  }
  if (!settings.USE_PROXY) {
    console.log(`You are running bot without proxies!!!`.yellow);
  }

  let maxThreads = settings.USE_PROXY ? settings.MAX_THEADS : settings.MAX_THEADS_NO_PROXY;

  const { endpoint, message } = await checkBaseUrl();
  if (!endpoint) return console.log(`Không thể tìm thấy ID API, thử lại sau!`.red);
  console.log(`${message}`.yellow);

  const itemDatas = accounts
    .map((val, index) => {
      const [email, password] = val.split("|");
      let wallet = null;
      // if (data[index]) {
      //   try {
      //     wallet = getWalletFromPrivateKey(data[index]);
      //   } catch (error) {
      //     console.log(`Error parsing wallet: ${error.message}`.red);
      //   }
      // } else {
      // }
      const item = {
        email: email,
        password: password,
        index,
        ...(wallet
          ? {
              privateKey: data[index],
              publicKey: wallet.publicKey,
              secretKey: wallet.secretKey,
              address: wallet.publicKey.toBase58(),
            }
          : {}),
      };
      return item;
    })
    .filter((i) => i !== null);

  process.on("SIGINT", async () => {
    console.log("Stopping...".yellow);
    stopInterVal();
    await sleep(1);
    process.exit();
  });

  await sleep(1);
  // while (true) {
  try {
    const newLocalData = await fsPromises.readFile("localStorage.json", "utf8");
    localStorage = JSON.parse(newLocalData);
  } catch (error) {
    console.log(`Can't load data localStorage.json | Clearing data...`.red);
    await fsPromises.writeFile("localStorage.json", JSON.stringify({}));
    localStorage = {}; // Khởi tạo localStorage như một đối tượng rỗng
  }
  await sleep(2);
  for (let i = 0; i < itemDatas.length; i += maxThreads) {
    const batch = itemDatas.slice(i, i + maxThreads);
    const promises = batch.map(async (itemData, indexInBatch) => {
      const accountIndex = i + indexInBatch;
      const proxy = proxies[accountIndex] || null;
      const client = new ClientAPI(itemData, accountIndex, proxy, endpoint, localStorage);
      return client.runAccount();
    });
    await Promise.all(promises);
  }
  // }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
