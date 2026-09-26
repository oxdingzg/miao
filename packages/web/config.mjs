const stage = process.env.SST_STAGE || "dev"

export default {
  url: stage === "production" ? "https://miao.dtee.top" : `https://${stage}.miao.dtee.top`,
  console: stage === "production" ? "https://miao.dtee.top/auth" : `https://${stage}.miao.dtee.top/auth`,
  email: "help@anoma.ly",
  socialCard: "https://social-cards.sst.dev",
  github: "https://github.com/anomalyco/opencode",
  discord: "https://opencode.ai/discord",
  headerLinks: [
    { name: "app.header.home", url: "/" },
    { name: "app.header.docs", url: "/v2/docs" },
  ],
}
