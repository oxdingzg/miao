export function isNativeResourceError(error: unknown) {
  return (
    error instanceof Error &&
    /^Failed to create (?:TextBuffer(?:View)?|EditBuffer|EditorView|SyntaxStyle|native renderable|optimized buffer)(?::.*)?$/.test(
      error.message,
    )
  )
}
