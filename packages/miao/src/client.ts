import { OpenCode } from "@miao/client"

export type Client = ReturnType<typeof OpenCode.make>

export function createClient(
  input: Parameters<typeof OpenCode.make>[0] & { directory?: string; signal?: AbortSignal },
) {
  const headers = new Headers(input.headers)
  if (input.directory) headers.set("x-opencode-directory", encodeURIComponent(input.directory))
  return OpenCode.make({
    baseUrl: input.baseUrl,
    headers,
    fetch: Object.assign(
      (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const request = new Request(url, init)
        return (input.fetch ?? fetch)(
          new Request(request, {
            signal: input.signal ? AbortSignal.any([input.signal, request.signal]) : request.signal,
          }),
        )
      },
      { preconnect: (input.fetch ?? fetch).preconnect },
    ),
  })
}
