import { postgresBlobStore } from "../../../../core/server/blob/postgres";
import { getTestDb } from "../../../support/test-database";
import { blobStoreContract } from "./blob.contract";

blobStoreContract("postgres", () => postgresBlobStore(getTestDb()));
