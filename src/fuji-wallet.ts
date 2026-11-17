import { createPublicClient, http } from "viem";
import { avalancheFuji } from "viem/chains";
import { redactSecrets } from "./wallet-store.js";

export const FUJI_CHAIN_ID = 43113 as const;
export const FUJI_NETWORK = "eip155:43113" as const;
export const FUJI_RPC_URL = "https://api.avax-test.network/ext/bc/C/rpc";
export const FUSD_ASSET_ADDRESS =
  "0xe7082a54a456dc4dfe0ceadcd0d0dce7d8ba176f" as const;
export const FUSD_DECIMALS = 6 as const;
export const FUSD_SYMBOL = "fUSD" as const;
export const FACET_FEE_SPLIT_ADDRESS =
  "0xc50cb5d5ff6c71eb1b065971c198a9edb0ecff06" as const;
export const FACET_ACTOR_REGISTRY_ADDRESS =
  "0xc37c12bcd53a4ba5fd33870cecc74a4ba601e3a2" as const;
export const FACET_RECEIPT_LOG_ADDRESS =
  "0x5dc611b5642c306dd50fa7f786194dc04bd12fa7" as const;
export const DEFAULT_FACET_ORIGIN = "https://facet.briandev.space" as const;

const ERC20_BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export type FujiWalletErrorCode = "WRONG_CHAIN_ID" | "FUJI_RPC_ERROR";

export class FujiWalletError extends Error {
  constructor(
    public readonly code: FujiWalletErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FujiWalletError";
  }
}

export interface FujiRpcClient {
  getChainId(): Promise<number>;
  readFusdBalance(
    address: `0x${string}`,
    assetAddress: `0x${string}`,
  ): Promise<bigint>;
}

export interface FujiWalletStatus {
  address: `0x${string}`;
  chainId: 43113;
  network: "eip155:43113";
  assetAddress: `0x${string}`;
  symbol: "fUSD";
  decimals: 6;
  balanceAtomic: string;
  balanceFormatted: string;
  fundingNote: string;
}

export function formatFusdAtomic(atomic: bigint): string {
  const unit = 10n ** BigInt(FUSD_DECIMALS);
  const negative = atomic < 0n;
  const abs = negative ? -atomic : atomic;
  const whole = abs / unit;
  const frac = (abs % unit).toString().padStart(FUSD_DECIMALS, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${frac}`;
}

export function createViemFujiClient(
  rpcUrl = process.env.FACET_FUJI_RPC_URL ?? FUJI_RPC_URL,
): FujiRpcClient {
  const client = createPublicClient({
    chain: avalancheFuji,
    transport: http(rpcUrl),
  });
  return {
    async getChainId() {
      return client.getChainId();
    },
    async readFusdBalance(address, assetAddress) {
      return client.readContract({
        address: assetAddress,
        abi: ERC20_BALANCE_ABI,
        functionName: "balanceOf",
        args: [address],
      });
    },
  };
}

export async function readFujiWalletStatus(
  address: `0x${string}`,
  options?: { rpcUrl?: string; client?: FujiRpcClient },
): Promise<FujiWalletStatus> {
  const client = options?.client ?? createViemFujiClient(options?.rpcUrl);
  let chainId: number;
  try {
    chainId = await client.getChainId();
  } catch (error) {
    throw new FujiWalletError(
      "FUJI_RPC_ERROR",
      redactSecrets(
        `Failed to query Fuji RPC chain ID: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  if (chainId !== FUJI_CHAIN_ID) {
    throw new FujiWalletError(
      "WRONG_CHAIN_ID",
      `Expected Avalanche Fuji chain ID ${FUJI_CHAIN_ID}, got ${chainId}.`,
    );
  }

  let balance: bigint;
  try {
    balance = await client.readFusdBalance(address, FUSD_ASSET_ADDRESS);
  } catch (error) {
    throw new FujiWalletError(
      "FUJI_RPC_ERROR",
      redactSecrets(
        `Failed to read fUSD balance on Fuji: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }

  return {
    address,
    chainId: FUJI_CHAIN_ID,
    network: FUJI_NETWORK,
    assetAddress: FUSD_ASSET_ADDRESS,
    symbol: FUSD_SYMBOL,
    decimals: FUSD_DECIMALS,
    balanceAtomic: balance.toString(),
    balanceFormatted: formatFusdAtomic(balance),
    fundingNote:
      "FacetUSD on Fuji is owner-minted; top up via explicit operator transfer to this address.",
  };
}
