// Development-only native ABI probe. Build against the header from the verified
// official archive; no Python, Node binding, package install, or network client.
#include <dlfcn.h>
#include <signal.h>
#include <stdio.h>
#include <sys/stat.h>
#include "vosk_api.h"

static volatile sig_atomic_t cancelled = 0;
static void cancel_probe(int signal_number) { (void)signal_number; cancelled = 1; }

#define LOAD(name) \
    __typeof__(name) *api_##name = (__typeof__(name) *)dlsym(library, #name); \
    if (!api_##name) { fputs("missing Vosk symbol\n", stderr); fclose(audio); dlclose(library); return 1; }

int main(int argc, char **argv) {
    if (argc != 4) {
        fputs("Usage: vosk-probe ABSOLUTE_LIBRARY MODEL_DIR PCM16_MONO_16KHZ\n", stderr);
        return 2;
    }
    if (argv[1][0] != '/') { fputs("absolute library path required\n", stderr); return 2; }
    FILE *audio = fopen(argv[3], "rb");
    struct stat info;
    if (!audio || fstat(fileno(audio), &info) || !S_ISREG(info.st_mode)
        || info.st_size <= 0 || info.st_size > 120 * 32000 || info.st_size % 2) {
        if (audio) fclose(audio);
        fputs("expected bounded nonempty PCM16 file\n", stderr);
        return 2;
    }
    void *library = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
    if (!library) { fclose(audio); fputs("native library load failed\n", stderr); return 1; }
    LOAD(vosk_set_log_level);
    LOAD(vosk_model_new);
    LOAD(vosk_model_free);
    LOAD(vosk_recognizer_new);
    LOAD(vosk_recognizer_free);
    LOAD(vosk_recognizer_set_words);
    LOAD(vosk_recognizer_accept_waveform);
    LOAD(vosk_recognizer_result);
    LOAD(vosk_recognizer_final_result);
    signal(SIGINT, cancel_probe);
    signal(SIGTERM, cancel_probe);
    fputs("VOSK_PROBE_READY\n", stderr);
    fflush(stderr);
    api_vosk_set_log_level(-1);
    VoskModel *model = api_vosk_model_new(argv[2]);
    VoskRecognizer *recognizer = model && !cancelled ? api_vosk_recognizer_new(model, 16000.0f) : NULL;
    int code = 1;
    if (recognizer) {
        api_vosk_recognizer_set_words(recognizer, 1);
        char buffer[8000];
        size_t count;
        size_t total = 0;
        int first = 1;
        fputs("[", stdout);
        code = 0;
        while (!cancelled && (count = fread(buffer, 1, sizeof(buffer), audio)) > 0) {
            total += count;
            if (total > 120 * 32000 || count % 2) { code = 1; break; }
            int accepted = api_vosk_recognizer_accept_waveform(recognizer, buffer, (int)count);
            if (accepted < 0) { code = 1; break; }
            if (accepted) {
                printf("%s%s", first ? "" : ",", api_vosk_recognizer_result(recognizer));
                first = 0;
            }
        }
        if (ferror(audio)) code = 1;
        if (!cancelled && !code) {
            const char *result = api_vosk_recognizer_final_result(recognizer);
            if (!cancelled) printf("%s%s]\n", first ? "" : ",", result);
        }
        api_vosk_recognizer_free(recognizer);
    }
    if (model) api_vosk_model_free(model);
    fclose(audio);
    dlclose(library);
    if (cancelled) return 130;
    if (code) fputs("Vosk initialization or recognition failed\n", stderr);
    return code;
}
