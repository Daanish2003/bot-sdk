import { postgresBlobStore } from "../../../../core/server/storage";
import { getTestDb } from "../../../support/test-database";
import { blobStoreContract } from "./blob.contract";

blobStoreContract("postgres", () => postgresBlobStore(getTestDb()));
