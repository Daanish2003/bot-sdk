import { postgresBlobStore } from "@botsdk/bot/storage";
import { getTestDb } from "../../../support/test-database";
import { blobStoreContract } from "./blob.contract";

blobStoreContract("postgres", () => postgresBlobStore(getTestDb()));
