/* The C interface between the Rust crate and Tesseract's C++ API. Every function
 * catches every C++ exception, so none crosses into Rust. */
#ifndef MARFA_SHIM_H
#define MARFA_SHIM_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* A model carried inside the program. */
typedef struct marfa_model {
  const char *language;
  const uint8_t *data;
  size_t len;
} marfa_model;

enum marfa_status {
  MARFA_OK = 0,
  /* A language has no model in the data folder or in the program. */
  MARFA_MODEL_MISSING = 1,
  /* A model is there and Tesseract could not load it. */
  MARFA_MODEL_UNLOADABLE = 2,
  /* Anything else, including a C++ exception. */
  MARFA_FAILED = 3
};

typedef struct marfa_ocr marfa_ocr;

/* Starts an engine for `languages` (names joined by '+'). Each language's model
 * is read from `<data_dir>/<language>.traineddata` when that file exists
 * (`data_dir` may be NULL), and otherwise from `models`. Nothing is written. On
 * failure returns NULL, sets `*status` and writes a message. */
marfa_ocr *marfa_ocr_open(const char *languages, const char *data_dir,
                          const marfa_model *models, size_t model_count,
                          int *status, char *message, size_t message_len);

void marfa_ocr_close(marfa_ocr *ocr);

/* Reads one 8-bit gray image of `width` x `height` pixels, in rows of `width`
 * bytes, drawn at `dpi`. `deadline_ms` above zero stops the recognition after
 * that long; `*cut_short` is then 1 and `*text` holds what was read until then.
 * On success `*text` is a UTF-8 string to release with marfa_text_free. */
int marfa_ocr_read(marfa_ocr *ocr, const uint8_t *pixels, int width, int height,
                   int dpi, int deadline_ms, char **text, int *cut_short,
                   char *message, size_t message_len);

void marfa_text_free(char *text);

#ifdef __cplusplus
}
#endif

#endif
