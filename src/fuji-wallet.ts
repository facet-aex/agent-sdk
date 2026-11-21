import {
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
  keccak256,
  parseAbi,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { avalancheFuji } from "viem/chains";
import { redactSecrets } from "./wallet-store.js";

export const FUJI_CHAIN_ID = 43113 as const;
export const FUJI_NETWORK = "eip155:43113" as const;
export const FUJI_RPC_URL = "https://api.avax-test.network/ext/bc/C/rpc";
export const FUSD_ASSET_ADDRESS =
  "0xe7082a54a456dc4dfe0ceadcd0d0dce7d8ba176f" as const;
export const FUSD_DECIMALS = 6 as const;
export const FUSD_SYMBOL = "fUSD" as const;
export const FACET_LEGACY_FEE_SPLIT_V1_ADDRESS =
  "0xc50cb5d5ff6c71eb1b065971c198a9edb0ecff06" as const;
// TODO(T8): update to deployed FacetFeeSplitAndEscrow v2 address after Fuji deployment.
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
        `Failed to query Avalanche RPC chain ID: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  if (chainId !== FUJI_CHAIN_ID) {
    throw new FujiWalletError(
      "WRONG_CHAIN_ID",
      `Expected Avalanche chain ID ${FUJI_CHAIN_ID}, got ${chainId}.`,
    );
  }

  let balance: bigint;
  try {
    balance = await client.readFusdBalance(address, FUSD_ASSET_ADDRESS);
  } catch (error) {
    throw new FujiWalletError(
      "FUJI_RPC_ERROR",
      redactSecrets(
        `Failed to read fUSD balance on Avalanche: ${error instanceof Error ? error.message : String(error)}`,
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
      "Fund this Avalanche wallet with testnet fUSD via /faucet on FACET or an explicit transfer.",
  };
}

export type OnChainEscrowStateName = "UNUSED" | "ESCROWED" | "SETTLED" | "REFUNDED";

const RUN_STATE_NAMES: readonly OnChainEscrowStateName[] = [
  "UNUSED",
  "ESCROWED",
  "SETTLED",
  "REFUNDED",
];

const ESCROW_ABI = parseAbi([
  "function runState(bytes32) view returns (uint8)",
  "function escrows(bytes32) view returns (bytes32 facetId,address payer,address creatorPayTo,uint256 unitPriceAtomic,uint256 maxAmount,uint64 expiresAt)",
  "function refundEscrow(bytes32 runId)",
]);

export interface EscrowStateSnapshot {
  runId: string;
  runKey: Hex;
  contractAddress: Address;
  state: OnChainEscrowStateName;
  facetId: Hex;
  payer: Address;
  creatorPayTo: Address;
  unitPriceAtomic: string;
  maxAmountAtomic: string;
  expiresAtUnix: number;
  expiresAtIso: string;
  expired: boolean;
}

export interface EscrowReclaimResult {
  runId: string;
  runKey: Hex;
  contractAddress: Address;
  txHash: Hex;
  payer: Address;
  refundAmountAtomic: string;
}

export interface EscrowRpcClient {
  readEscrowState(runId: string): Promise<EscrowStateSnapshot>;
  reclaimExpiredEscrow(
    account: PrivateKeyAccount,
    runId: string,
  ): Promise<EscrowReclaimResult>;
}

export function resolveFeeSplitContractAddress(
  override?: string,
  env: NodeJS.ProcessEnv = process.env,
): Address {
  const candidate =
    override?.trim() ||
    env.FACET_FEE_SPLIT_ADDRESS?.trim() ||
    FACET_FEE_SPLIT_ADDRESS;
  if (!isAddress(candidate)) {
    throw new FujiWalletError(
      "FUJI_RPC_ERROR",
      `Invalid settlement contract address '${candidate}'.`,
    );
  }
  return candidate;
}

export function createViemEscrowClient(options?: {
  rpcUrl?: string;
  contractAddress?: string;
  env?: NodeJS.ProcessEnv;
}): EscrowRpcClient {
  const rpcUrl =
    options?.rpcUrl ?? options?.env?.FACET_FUJI_RPC_URL ?? FUJI_RPC_URL;
  const contractAddress = resolveFeeSplitContractAddress(
    options?.contractAddress,
    options?.env,
  );
  const publicClient = createPublicClient({
    chain: avalancheFuji,
    transport: http(rpcUrl),
  });

  const readEscrowState = async (runId: string): Promise<EscrowStateSnapshot> => {
    const runKey = keccak256(stringToHex(runId));
    const [rawState, escrowTuple] = await Promise.all([
      publicClient.readContract({
        address: contractAddress,
        abi: ESCROW_ABI,
        functionName: "runState",
        args: [runKey],
      }),
      publicClient.readContract({
        address: contractAddress,
        abi: ESCROW_ABI,
        functionName: "escrows",
        args: [runKey],
      }),
    ]);
    const state = RUN_STATE_NAMES[Number(rawState)] ?? "UNUSED";
    const expiresAtUnix = Number(escrowTuple[5]);
    const nowUnix = Math.floor(Date.now() / 1000);
    return {
      runId,
      runKey,
      contractAddress,
      state,
      facetId: escrowTuple[0],
      payer: escrowTuple[1],
      creatorPayTo: escrowTuple[2],
      unitPriceAtomic: escrowTuple[3].toString(),
      maxAmountAtomic: escrowTuple[4].toString(),
      expiresAtUnix,
      expiresAtIso:
        expiresAtUnix > 0 ? new Date(expiresAtUnix * 1000).toISOString() : "",
      expired:
        state === "ESCROWED" && expiresAtUnix > 0 && nowUnix >= expiresAtUnix,
    };
  };

  const reclaimExpiredEscrow = async (
    account: PrivateKeyAccount,
    runId: string,
  ): Promise<EscrowReclaimResult> => {
    const snapshot = await readEscrowState(runId);
    if (snapshot.state !== "ESCROWED") {
      throw new FujiWalletError(
        "FUJI_RPC_ERROR",
        `Escrow for run ${runId} is not active on Avalanche (state: ${snapshot.state}).`,
      );
    }
    if (!snapshot.expired) {
      throw new FujiWalletError(
        "FUJI_RPC_ERROR",
        `Escrow for run ${runId} has not expired yet (expires at ${snapshot.expiresAtIso}).`,
      );
    }
    const walletClient = createWalletClient({
      account,
      chain: avalancheFuji,
      transport: http(rpcUrl),
    });
    const txHash = await walletClient.writeContract({
      address: contractAddress,
      abi: ESCROW_ABI,
      functionName: "refundEscrow",
      args: [snapshot.runKey],
      account,
      chain: avalancheFuji,
    });
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: 60_000,
    });
    if (receipt.status !== "success") {
      throw new FujiWalletError(
        "FUJI_RPC_ERROR",
        `Escrow reclaim transaction reverted on Avalanche (${txHash}).`,
      );
    }
    return {
      runId,
      runKey: snapshot.runKey,
      contractAddress,
      txHash,
      payer: snapshot.payer,
      refundAmountAtomic: snapshot.maxAmountAtomic,
    };
  };

  return { readEscrowState, reclaimExpiredEscrow };
}

export async function readEscrowState(
  runId: string,
  options?: { rpcUrl?: string; contractAddress?: string; client?: EscrowRpcClient },
): Promise<EscrowStateSnapshot> {
  const client = options?.client ?? createViemEscrowClient(options);
  return client.readEscrowState(runId);
}

export async function reclaimExpiredEscrow(
  account: PrivateKeyAccount,
  runId: string,
  options?: { rpcUrl?: string; contractAddress?: string; client?: EscrowRpcClient },
): Promise<EscrowReclaimResult> {
  const client = options?.client ?? createViemEscrowClient(options);
  return client.reclaimExpiredEscrow(account, runId);
}
