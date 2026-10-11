# Media observation through coding tools

The native engine follows the existing product media workflow: load a skill,
run `ffprobe`/`ffmpeg` through the ordinary confined Bash capability, then inspect
the resulting frames/contact sheets as images. It does not add a separate video
provider or transcription service.

`load_skill` accepts `{"name":"media-observe"}`. Its body is compiled from the
same built-in Markdown used by the TypeScript product. The system context lists
only the skill metadata and body fingerprint; it loads instructions on demand.
The returned tool mapping makes the native vocabulary explicit: `bash` for
commands, `read_image` for images, and `read_file` for textual probe/QC results.
Project skills continue to be discovered and read through their listed paths.

`read_image` accepts `{"path":"out/sheets/sheet_001.jpg"}`. Read permission,
protected-resource checks, workspace/authorized-reference path boundaries,
revalidation and cancellation apply. It accepts regular PNG/JPEG/GIF/WebP files
up to 4 MiB, identifies their MIME type from the bytes rather than the extension,
and records the actual bytes' SHA-256. Oversize and unsupported inputs fail.
Format identification does not replace the provider's image decoder validation.

On durable completion, the image is projected as a canonical image part beside
its tool-result metadata. The text result and `tool.completed` receipt carry the
path, MIME, byte count, fingerprint and `image_attached` flag, not base64 text.
The provider turn reloads this projected history and encodes pixels in its own
wire format. Historical replay/fork/export therefore retains the observed image
rather than reopening a possibly changed pathname.

`tests/media.rs` exercises real runtime admission and HTTP provider requests for
Anthropic, OpenAI Chat, OpenAI Responses and Gemini, plus file bounds and invalid
formats. An explicit ignored test, requiring installed ffmpeg, creates a video
and runs the complete built-in skill → confined Bash extraction → image read →
provider pixel request sequence. It verifies the pipeline, not model accuracy.

Speech transcription remains dependent on tooling configured by the user, as in
the shared skill. Contact sheets are evidence of frames; they are not evidence
of dialogue. Commands require the usual process authority, and external tool
availability is checked by the skill workflow.
