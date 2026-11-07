#include "shim.h"

#include <leptonica/allheaders.h>
#include <tesseract/baseapi.h>
#include <tesseract/ocrclass.h>

#include <cstdio>
#include <cstring>
#include <exception>
#include <fstream>
#include <new>
#include <string>
#include <vector>

namespace {

constexpr const char *kSuffix = ".traineddata";
// A model is megabytes. Anything near this is not one, and reading it whole would
// only fill the memory.
constexpr size_t kMaxModelBytes = 256u * 1024u * 1024u;

void write_message(char *message, size_t len, const std::string &text) {
  if (message == nullptr || len == 0) {
    return;
  }
  size_t n = text.size() < len - 1 ? text.size() : len - 1;
  std::memcpy(message, text.data(), n);
  message[n] = '\0';
}

bool valid_language(const std::string &name) {
  if (name.empty() || name.size() > 32) {
    return false;
  }
  for (char c : name) {
    bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
              (c >= '0' && c <= '9') || c == '_';
    if (!ok) {
      return false;
    }
  }
  return true;
}

std::vector<std::string> split_languages(const std::string &languages) {
  std::vector<std::string> out;
  size_t start = 0;
  while (start <= languages.size()) {
    size_t end = languages.find('+', start);
    if (end == std::string::npos) {
      end = languages.size();
    }
    out.push_back(languages.substr(start, end - start));
    start = end + 1;
  }
  return out;
}

enum class Source { None, Folder, Program };

// Where models come from for one Init. Tesseract's FileReader is a plain
// function pointer, so the loader it reads is the one of the Init in progress on
// this thread.
struct Loader {
  std::string data_dir;
  const marfa_model *models;
  size_t model_count;
  // The language whose file in the data folder could not be read.
  std::string unreadable;
  // The languages served from the data folder, for the message of a failure.
  std::vector<std::string> from_folder;

  std::string folder_path(const std::string &language) const {
    if (data_dir.empty()) {
      return std::string();
    }
    std::string dir = data_dir;
    if (dir.back() != '/') {
      dir += '/';
    }
    return dir + language + kSuffix;
  }

  const marfa_model *carried(const std::string &language) const {
    for (size_t i = 0; i < model_count; i++) {
      if (language == models[i].language) {
        return &models[i];
      }
    }
    return nullptr;
  }

  static bool exists(const std::string &path) {
    std::ifstream file(path, std::ios::binary);
    return file.good();
  }

  Source source_of(const std::string &language) const {
    std::string path = folder_path(language);
    if (!path.empty() && exists(path)) {
      return Source::Folder;
    }
    return carried(language) != nullptr ? Source::Program : Source::None;
  }

  bool read(const std::string &language, std::vector<char> *out) {
    std::string path = folder_path(language);
    if (!path.empty() && exists(path)) {
      std::ifstream file(path, std::ios::binary | std::ios::ate);
      std::streamoff size = file.good() ? static_cast<std::streamoff>(file.tellg()) : -1;
      if (size < 0 || static_cast<size_t>(size) > kMaxModelBytes) {
        unreadable = language;
        return false;
      }
      out->resize(static_cast<size_t>(size));
      file.seekg(0);
      if (size > 0 && !file.read(out->data(), size)) {
        unreadable = language;
        return false;
      }
      from_folder.push_back(language);
      return true;
    }
    const marfa_model *model = carried(language);
    if (model == nullptr) {
      return false;
    }
    const char *bytes = reinterpret_cast<const char *>(model->data);
    out->assign(bytes, bytes + model->len);
    return true;
  }
};

thread_local Loader *current_loader = nullptr;

// Tesseract asks for "<datadir><language>.traineddata". The folder part means
// nothing here: the loader finds the file by language.
bool serve_model(const char *filename, std::vector<char> *data) {
  try {
    Loader *loader = current_loader;
    if (loader == nullptr || filename == nullptr) {
      return false;
    }
    std::string name = filename;
    size_t slash = name.find_last_of('/');
    if (slash != std::string::npos) {
      name = name.substr(slash + 1);
    }
    size_t suffix = std::strlen(kSuffix);
    if (name.size() <= suffix || name.compare(name.size() - suffix, suffix, kSuffix) != 0) {
      return false;
    }
    std::string language = name.substr(0, name.size() - suffix);
    if (!valid_language(language)) {
      return false;
    }
    return loader->read(language, data);
  } catch (...) {
    return false;
  }
}

}  // namespace

struct marfa_ocr {
  tesseract::TessBaseAPI api;
};

extern "C" {

marfa_ocr *marfa_ocr_open(const char *languages, const char *data_dir,
                          const marfa_model *models, size_t model_count,
                          int *status, char *message, size_t message_len) {
  marfa_ocr *ocr = nullptr;
  try {
    Loader loader;
    loader.data_dir = data_dir != nullptr ? data_dir : "";
    loader.models = models;
    loader.model_count = model_count;

    std::string wanted = languages != nullptr ? languages : "";
    std::vector<std::string> names = split_languages(wanted);
    for (const std::string &name : names) {
      if (!valid_language(name)) {
        *status = MARFA_MODEL_MISSING;
        write_message(message, message_len, "'" + name + "' is not a language name");
        return nullptr;
      }
      if (loader.source_of(name) == Source::None) {
        *status = MARFA_MODEL_MISSING;
        write_message(message, message_len,
                      "no model for language '" + name + "' in the data folder or in the program");
        return nullptr;
      }
    }

    ocr = new marfa_ocr();
    current_loader = &loader;
    // The folder is a name Tesseract puts before each file name, which the loader
    // ignores: it must not be empty, or Tesseract looks for its own.
    int rc = ocr->api.Init("marfa-models/", 0, wanted.c_str(), tesseract::OEM_LSTM_ONLY, nullptr, 0,
                           nullptr, nullptr, false, serve_model);
    current_loader = nullptr;

    std::vector<std::string> loaded;
    if (rc == 0) {
      ocr->api.GetLoadedLanguagesAsVector(&loaded);
    }
    // A language after the first that fails to load is logged and skipped by
    // Tesseract, so the engine is counted as failed unless all are there.
    if (rc != 0 || loaded.size() != names.size()) {
      std::string text = "Tesseract could not load the model for '" + wanted + "'";
      if (!loader.unreadable.empty()) {
        text += ": " + loader.folder_path(loader.unreadable) + " cannot be read";
      } else if (!loader.from_folder.empty()) {
        text += ", and the data folder supplied";
        for (const std::string &language : loader.from_folder) {
          text += " " + loader.folder_path(language);
        }
      }
      *status = MARFA_MODEL_UNLOADABLE;
      write_message(message, message_len, text);
      ocr->api.End();
      delete ocr;
      return nullptr;
    }
    ocr->api.SetPageSegMode(tesseract::PSM_AUTO);
    *status = MARFA_OK;
    return ocr;
  } catch (const std::exception &error) {
    current_loader = nullptr;
    delete ocr;
    *status = MARFA_FAILED;
    write_message(message, message_len, std::string("OCR failed to start: ") + error.what());
    return nullptr;
  } catch (...) {
    current_loader = nullptr;
    delete ocr;
    *status = MARFA_FAILED;
    write_message(message, message_len, "OCR failed to start");
    return nullptr;
  }
}

void marfa_ocr_close(marfa_ocr *ocr) {
  try {
    if (ocr != nullptr) {
      ocr->api.End();
      delete ocr;
    }
  } catch (...) {
  }
}

int marfa_ocr_read(marfa_ocr *ocr, const uint8_t *pixels, int width, int height, int dpi,
                   int deadline_ms, char **text, int *cut_short, char *message,
                   size_t message_len) {
  *text = nullptr;
  *cut_short = 0;
  try {
    ocr->api.SetImage(pixels, width, height, 1, width);
    ocr->api.SetSourceResolution(dpi);
    tesseract::ETEXT_DESC monitor;
    if (deadline_ms > 0) {
      monitor.set_deadline_msecs(deadline_ms);
    }
    int rc = ocr->api.Recognize(&monitor);
    if (rc != 0) {
      ocr->api.Clear();
      write_message(message, message_len, "Tesseract could not recognize the image");
      return MARFA_FAILED;
    }
    *cut_short = monitor.deadline_exceeded() ? 1 : 0;
    *text = ocr->api.GetUTF8Text();
    ocr->api.Clear();
    return MARFA_OK;
  } catch (const std::exception &error) {
    write_message(message, message_len, std::string("OCR failed: ") + error.what());
    return MARFA_FAILED;
  } catch (...) {
    write_message(message, message_len, "OCR failed");
    return MARFA_FAILED;
  }
}

void marfa_text_free(char *text) { delete[] text; }

}  // extern "C"
