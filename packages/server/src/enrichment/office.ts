import { parseOffice } from "officeparser";
import type { SupportedFileType } from "officeparser";

/**
 * MIME types the document extractor handles, mapped to the parser's file
 * type hint. Sniffing from bytes alone misreads the zip-container formats
 * (a docx and an odt are both zip archives), so the item's declared
 * `mime_type` drives the dispatch and the hint pins the parser's reading.
 */
export const OFFICE_MIME_TO_FILE_TYPE: Readonly<
  Record<string, SupportedFileType>
> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "pptx",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.presentation": "odp",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
};

/**
 * Extracts the plain text of a document. PDF extraction reads embedded
 * text only — a scanned page-image PDF yields nothing, deliberately: OCR
 * of rasterized pages is a different cost class and stays out of the
 * deterministic sweep. The parser's own optional OCR stays off for the
 * same reason.
 */
export async function extractOfficeText(
  bytes: Buffer,
  fileType: SupportedFileType,
): Promise<string> {
  const ast = await parseOffice(bytes, { fileType });
  const result = await ast.to("text");
  return result.value;
}
