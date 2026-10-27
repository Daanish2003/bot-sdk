import { botContract } from "./bot/contract";
import { modelsContract } from "./models/contract";

/**
 * The core's contract (spec #873): the Bot core's namespaces and `models`, as the HTTP layer serves
 * them under `<basePath>/rpc`. The browser client is typed by it and each feature's contract,
 * never by server code.
 */
export const coreContract = { ...botContract, ...modelsContract };

export type CoreContract = typeof coreContract;
