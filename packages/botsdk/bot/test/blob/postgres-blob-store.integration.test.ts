import { postgresBlobStore } from "../../src/storage";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { blobStoreContract } from "@ai-chat/test-support/blob.contract";

blobStoreContract("postgres", () => postgresBlobStore(getTestDb()));
