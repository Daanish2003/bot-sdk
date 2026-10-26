import { postgres } from "../../../../core/server/database";
import { mcp } from "../../../../plugins/mcp/server";

// The config the `botsdk migrate` CLI test loads: the test's database, with Connectors on.
export default {
  database: postgres({ connectionString: process.env.BOTSDK_TEST_DATABASE_URL! }),
  features: [mcp()],
};
