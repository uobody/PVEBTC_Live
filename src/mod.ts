import { request } from "https";
import * as fs from "fs";
import * as path from "path";
import { DependencyContainer } from "tsyringe";
import { ILogger } from "@spt-aki/models/spt/utils/ILogger";
import { DatabaseServer } from "@spt-aki/servers/DatabaseServer";
import { ITemplateItem } from "@spt-aki/models/eft/common/tables/ITemplateItem";

interface LBPRConfig {
    updateInterval: number;
    enableLogging: boolean;
    enablePeriodicUpdates: boolean;
    advanced: {
        enablePriceCaching: boolean;
        apiTimeout: number;
        userAgent: string;
    };
}

interface PriceCache {
    [itemId: string]: number;
    gameMode: string;
    lastUpdate: number;
}

interface TarkovDevResponse {
    data?: {
        items?: Array<{
            basePrice: number;
        }>;
    };
    errors?: any[];
}

class LBPR {
    private static bitcoin: ITemplateItem | null = null;
    private static logger: ILogger | null = null;
    private static config: LBPRConfig | null = null;
    private static readonly configPath: string = path.resolve(__dirname, "../config/config.json");
    private static readonly pricePath: string = path.resolve(__dirname, "../config/price.json");
    
    // Constants
    private static readonly BITCOIN_ID: string = "59faff1d86f7746c51718c9c";
    private static readonly API_URL: string = "https://api.tarkov.dev/graphql";

    public async postDBLoadAsync(container: DependencyContainer): Promise<void> {
        try {
            LBPR.logger = container.resolve<ILogger>("WinstonLogger");
            LBPR.loadConfig();
            
            const db = container.resolve<DatabaseServer>("DatabaseServer");
            const handbook = db.getTables().templates.handbook;
            
            LBPR.bitcoin = handbook.Items.find(x => x.Id === LBPR.BITCOIN_ID) || null;
            
            if (!LBPR.bitcoin) {
                LBPR.log("Physical Bitcoin not found in handbook!", "error");
                return;
            }

            LBPR.log(`LiveBTC initialized for PVE pricing`);
            LBPR.log(`Current Bitcoin price: ${LBPR.bitcoin.Price} RUB`);

            // Always get fresh price on startup
            LBPR.log("Fetching current Bitcoin price...");
            const updateResult = await LBPR.updatePrice();
            if (updateResult) {
                LBPR.log("Price updated successfully");
            } else {
                LBPR.log("Failed to update Bitcoin price - using default", "warn");
            }

            // Schedule periodic updates
            if (LBPR.config?.enablePeriodicUpdates) {
                setInterval(() => LBPR.updatePrice(), LBPR.config.updateInterval * 1000);
                LBPR.log(`Updates scheduled every ${LBPR.config.updateInterval / 60} minutes`);
            }
            
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            LBPR.log(`LBPR initialization failed: ${errorMessage}`, "error");
        }
    }

    private static loadConfig(): void {
        const configDir = path.dirname(LBPR.configPath);
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }

        if (!fs.existsSync(LBPR.configPath)) {
            const defaultConfig: LBPRConfig = {
                updateInterval: 2700,
                enableLogging: true,
                enablePeriodicUpdates: true,
                advanced: {
                    enablePriceCaching: true,
                    apiTimeout: 15000,
                    userAgent: "SPT-LiveBTC-PVE"
                }
            };
            fs.writeFileSync(LBPR.configPath, JSON.stringify(defaultConfig, null, 4));
        }

        try {
            const configData = fs.readFileSync(LBPR.configPath, "utf-8");
            LBPR.config = JSON.parse(configData) as LBPRConfig;
        } catch (e) {
            const errorMessage = e instanceof Error ? e.message : String(e);
            LBPR.log(`Failed to load config: ${errorMessage}`, "error");
            LBPR.config = {
                updateInterval: 2700,
                enableLogging: true,
                enablePeriodicUpdates: true,
                advanced: {
                    enablePriceCaching: true,
                    apiTimeout: 15000,
                    userAgent: "SPT-LiveBTC-PVE"
                }
            };
        }
    }

    private static log(message: string, type: "info" | "warn" | "error" = "info"): void {
        if (!LBPR.config?.enableLogging) return;
        
        if (LBPR.logger && typeof LBPR.logger[type] === 'function') {
            (LBPR.logger[type] as (msg: string) => void)(message);
        } else {
            console.log(`[${type.toUpperCase()}] ${message}`);
        }
    }

    private static async updatePrice(): Promise<boolean> {
        return new Promise((resolve) => {
            const query = `query { items(gameMode: pve, name: "Physical Bitcoin") { basePrice } }`;
            
            const req = request(LBPR.API_URL, {
                method: "POST",
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': LBPR.config?.advanced?.userAgent || "SPT-LiveBTC-PVE"
                },
                timeout: LBPR.config?.advanced?.apiTimeout || 15000
            }, (res) => {
                let data = "";
                res.on("data", (chunk: Buffer) => data += chunk.toString());
                res.on("end", () => {
                    try {
                        const response: TarkovDevResponse = JSON.parse(data);
                        if (response.errors || !response.data?.items?.[0]) {
                            LBPR.log("Failed to fetch Bitcoin price data", "error");
                            resolve(false);
                            return;
                        }

                        const item = response.data.items[0];
                        const newPrice = item.basePrice;
                        
                        if (!newPrice || newPrice <= 0) {
                            LBPR.log("Invalid price received from API", "error");
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

                        // Cache price (simplified)
                        if (LBPR.config?.advanced?.enablePriceCaching) {
                            const cacheData: PriceCache = {
                                [LBPR.bitcoin.Id]: LBPR.bitcoin.Price,
                                gameMode: "pve",
                                lastUpdate: Math.floor(Date.now() / 1000)
                            };
                            fs.writeFileSync(LBPR.pricePath, JSON.stringify(cacheData, null, 2));
                        }
                        
                        resolve(true);
                    } catch (e) {
                        const errorMessage = e instanceof Error ? e.message : String(e);
                        LBPR.log(`Error parsing API response: ${errorMessage}`, "error");
                        resolve(false);
                    }
                });
            });

            req.on("error", (e: Error) => {
                LBPR.log(`API error: ${e.message}`, "error");
                resolve(false);
            });

            req.on("timeout", () => {
                LBPR.log("API request timeout", "error");
                req.destroy();
                resolve(false);
            });

            req.write(JSON.stringify({ query }));
            req.end();
        });
    }
}

export const mod = new LBPR();