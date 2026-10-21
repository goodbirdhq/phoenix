const fs = require("node:fs");

function resolvePublicConfig(env) {
  if (env.PUBLISH_NPM === "true" && env.NPM_TRUSTED_PUBLISHING !== "true") {
    throw new Error(
      "Requested npm publication requires NPM_TRUSTED_PUBLISHING=true and the npm trusted publisher setup",
    );
  }
  return {};
}

if (require.main === module) {
  const outputs = resolvePublicConfig(process.env);
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(outputs)
      .map(([key, val]) => `${key}=${val}\n`)
      .join(""),
  );
}
module.exports = { resolvePublicConfig };
