export const invoiceStatuses = [
  "pending",
  "processing",
  "success",
  "not_found",
  "invalid_data",
  "authentication_required",
  "conversation_error",
  "download_error",
  "timeout",
  "skipped"
] as const;

export type InvoiceStatus = (typeof invoiceStatuses)[number];
