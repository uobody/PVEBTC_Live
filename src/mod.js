"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.mod = void 0;
const https_1 = require("https");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
class LBPR {
    static bitcoin = null;
    static logger = null;
    static config = null;
    static configPath = path.resolve(__dirname, "../config/config.json");
    static pricePath = path.resolve(__dirname, "../config/price.json");
    // Constants
    static BITCOIN_ID = "59faff1d86f7746c51718c9c";
    static API_URL = "https://api.tarkov.dev/graphql";
    async postDBLoadAsync(container) {
        try {
            LBPR.logger = container.resolve("WinstonLogger");
            LBPR.loadConfig();
            const db = container.resolve("DatabaseServer");
            const handbook = db.getTables().templates.handbook;
            LBPR.bitcoin = handbook.Items.find(x => x.Id === LBPR.BITCOIN_ID) || null;
            if (!LBPR.bitcoin) {
                LBPR.log("Physical Bitcoin not found in handbook!", "error");
                return;
            }
            LBPR.log(`LiveBTC initialized for PVE pricing`);
            LBPR.log(`Current Bitcoin price: ${LBPR.bitcoin.Price} RUB`);
            // Always try to get fresh price on startup first
            LBPR.log("Fetching live Bitcoin price on startup...");
            const updateResult = await LBPR.updatePrice();
            if (updateResult) {
                LBPR.log("Price updated successfully with fresh live data");
            }
            else {
                LBPR.log("API failed on startup, attempting to use cached price as fallback", "warn");
                const cachedPrice = LBPR.loadCachedPrice();
                if (cachedPrice !== null) {
                    LBPR.bitcoin.Price = cachedPrice;
                    LBPR.log(`Using cached Bitcoin price as fallback: ${cachedPrice} RUB`);
                }
                else {
                    LBPR.log("No valid cached price available - keeping default price", "warn");
                }
            }
            // Schedule periodic updates
            if (LBPR.config?.enablePeriodicUpdates) {
                setInterval(async () => {
                    LBPR.log("Scheduled price update starting...");
                    const success = await LBPR.updatePrice();
                    if (!success) {
                        LBPR.log("Scheduled update failed, price remains unchanged");
                    }
                }, LBPR.config.updateInterval * 1000);
                LBPR.log(`Updates scheduled every ${LBPR.config.updateInterval / 60} minutes`);
            }
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            LBPR.log(`LBPR initialization failed: ${errorMessage}`, "error");
        }
    }
    static loadConfig() {
        const configDir = path.dirname(LBPR.configPath);
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }
        if (!fs.existsSync(LBPR.configPath)) {
            const defaultConfig = {
                updateInterval: 2700,
                enableLogging: true,
                enablePeriodicUpdates: true,
                advanced: {
                    enablePriceCaching: true,
                    cacheExpirationHours: 6,
                    apiTimeout: 15000,
                    userAgent: "SPT-LiveBTC-PVE"
                }
            };
            fs.writeFileSync(LBPR.configPath, JSON.stringify(defaultConfig, null, 4));
        }
        try {
            const configData = fs.readFileSync(LBPR.configPath, "utf-8");
            LBPR.config = JSON.parse(configData);
        }
        catch (e) {
            const errorMessage = e instanceof Error ? e.message : String(e);
            LBPR.log(`Failed to load config: ${errorMessage}`, "error");
            LBPR.config = {
                updateInterval: 2700,
                enableLogging: true,
                enablePeriodicUpdates: true,
                advanced: {
                    enablePriceCaching: true,
                    cacheExpirationHours: 6,
                    apiTimeout: 15000,
                    userAgent: "SPT-LiveBTC-PVE"
                }
            };
        }
    }
    static log(message, type = "info") {
        if (!LBPR.config?.enableLogging)
            return;
        if (LBPR.logger && typeof LBPR.logger[type] === 'function') {
            LBPR.logger[type](message);
        }
        else {
            console.log(`[${type.toUpperCase()}] ${message}`);
        }
    }
    static loadCachedPrice() {
        if (!LBPR.config?.advanced?.enablePriceCaching) {
            return null;
        }
        try {
            if (!fs.existsSync(LBPR.pricePath)) {
                LBPR.log("No price cache file found");
                return null;
            }
            const cacheData = JSON.parse(fs.readFileSync(LBPR.pricePath, "utf-8"));
            // Check if cache contains Bitcoin price
            const bitcoinPrice = cacheData[LBPR.BITCOIN_ID];
            if (typeof bitcoinPrice !== 'number' || bitcoinPrice <= 0) {
                LBPR.log("Invalid Bitcoin price in cache");
                return null;
            }
            // Check cache age
            const cacheAgeHours = (Date.now() / 1000 - cacheData.lastUpdate) / 3600;
            const maxCacheAgeHours = LBPR.config.advanced.cacheExpirationHours;
            if (cacheAgeHours > maxCacheAgeHours) {
                LBPR.log(`Cache expired (${cacheAgeHours.toFixed(1)}h old, max ${maxCacheAgeHours}h)`);
                return null;
            }
            LBPR.log(`Cache is valid (${cacheAgeHours.toFixed(1)}h old)`);
            return bitcoinPrice;
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            LBPR.log(`Failed to load cached price: ${errorMessage}`, "error");
            return null;
        }
    }
    static savePriceToCache(price) {
        if (!LBPR.config?.advanced?.enablePriceCaching) {
            return;
        }
        try {
            const cacheData = {
                [LBPR.BITCOIN_ID]: price,
                gameMode: "pve",
                lastUpdate: Math.floor(Date.now() / 1000)
            };
            const cacheDir = path.dirname(LBPR.pricePath);
            if (!fs.existsSync(cacheDir)) {
                fs.mkdirSync(cacheDir, { recursive: true });
            }
            fs.writeFileSync(LBPR.pricePath, JSON.stringify(cacheData, null, 2));
            LBPR.log("Price cached successfully");
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            LBPR.log(`Failed to save price to cache: ${errorMessage}`, "error");
        }
    }
    static async updatePrice() {
        return new Promise((resolve) => {
            const query = `query { items(gameMode: pve, name: "Physical Bitcoin") { basePrice } }`;
            const req = (0, https_1.request)(LBPR.API_URL, {
                method: "POST",
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': LBPR.config?.advanced?.userAgent || "SPT-LiveBTC-PVE"
                },
                timeout: LBPR.config?.advanced?.apiTimeout || 15000
            }, (res) => {
                let data = "";
                res.on("data", (chunk) => data += chunk.toString());
                res.on("end", () => {
                    try {
                        const response = JSON.parse(data);
                        if (response.errors || !response.data?.items?.[0]) {
                            LBPR.log("Failed to fetch Bitcoin price data", "error");
                            LBPR.handleApiFailure();
                            resolve(false);
                            return;
                        }
                        const item = response.data.items[0];
                        const newPrice = item.basePrice;
                        if (!newPrice || newPrice <= 0) {
                            LBPR.log("Invalid price received from API", "error");
                            LBPR.handleApiFailure();
                            resolve(false);
                            return;
                        }
                        if (!LBPR.bitcoin) {
                            LBPR.log("Bitcoin object is null", "error");
                            resolve(false);
                            return;
                        }
                        const oldPrice = LBPR.bitcoin.Price;
                        LBPR.bitcoin.Price = Math.floor(newPrice);
                        const diff = LBPR.bitcoin.Price - oldPrice;
                        LBPR.log(`Bitcoin (PVE): ${oldPrice} → ${LBPR.bitcoin.Price} RUB (${diff > 0 ? '+' : ''}${diff})`);
                        // Save to cache
                        LBPR.savePriceToCache(LBPR.bitcoin.Price);
                        resolve(true);
                    }
                    catch (e) {
                        const errorMessage = e instanceof Error ? e.message : String(e);
                        LBPR.log(`Error parsing API response: ${errorMessage}`, "error");
                        LBPR.handleApiFailure();
                        resolve(false);
                    }
                });
            });
            req.on("error", (e) => {
                LBPR.log(`API error: ${e.message}`, "error");
                LBPR.handleApiFailure();
                resolve(false);
            });
            req.on("timeout", () => {
                LBPR.log("API request timeout", "error");
                req.destroy();
                LBPR.handleApiFailure();
                resolve(false);
            });
            req.write(JSON.stringify({ query }));
            req.end();
        });
    }
    static handleApiFailure() {
        if (!LBPR.bitcoin)
            return;
        const cachedPrice = LBPR.loadCachedPrice();
        if (cachedPrice !== null && cachedPrice !== LBPR.bitcoin.Price) {
            const oldPrice = LBPR.bitcoin.Price;
            LBPR.bitcoin.Price = cachedPrice;
            LBPR.log(`Fallback to cached price: ${oldPrice} → ${cachedPrice} RUB`);
        }
        else if (cachedPrice !== null) {
            LBPR.log(`Current price matches cache: ${LBPR.bitcoin.Price} RUB`);
        }
        else {
            LBPR.log(`No valid cache available, keeping current price: ${LBPR.bitcoin.Price} RUB`);
        }
    }
}
exports.mod = new LBPR();
//# sourceMappingURL=mod.js.map