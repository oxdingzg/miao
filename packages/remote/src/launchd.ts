// macOS launchd user agent for running `miao remote` in the background.

export const Label = "dev.mtty.miao.remote"

export function plist(input: {
  readonly program: ReadonlyArray<string>
  readonly workingDirectory: string
  readonly logFile: string
  readonly environment: Readonly<Record<string, string>>
}) {
  const strings = (values: ReadonlyArray<string>) => values.map((value) => `    <string>${escape(value)}</string>`)
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${Label}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...strings(input.program),
    `  </array>`,
    `  <key>WorkingDirectory</key>`,
    `  <string>${escape(input.workingDirectory)}</string>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    ...Object.entries(input.environment).flatMap(([key, value]) => [
      `    <key>${escape(key)}</key>`,
      `    <string>${escape(value)}</string>`,
    ]),
    `  </dict>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    // Restart after crashes, but not after a clean exit such as "login expired".
    `  <key>KeepAlive</key>`,
    `  <dict>`,
    `    <key>SuccessfulExit</key>`,
    `    <false/>`,
    `  </dict>`,
    `  <key>ThrottleInterval</key>`,
    `  <integer>30</integer>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${escape(input.logFile)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${escape(input.logFile)}</string>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n")
}

function escape(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
}
