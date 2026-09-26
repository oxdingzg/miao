declare global {
  const MIAO_VERSION: string
  const MIAO_CHANNEL: string
}

export const InstallationVersion = typeof MIAO_VERSION === "string" ? MIAO_VERSION : "local"
export const InstallationChannel = typeof MIAO_CHANNEL === "string" ? MIAO_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
