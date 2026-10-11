---
kind: reference
status: active
title: Native project_search versus IDX — reproducible measured comparison
---

# Native project_search и IDX: методика воспроизводимого сравнения

Связанный контракт: [spec](../../specs/repository-search-comparison.md).
Это benchmark двух **реальных backend-адаптеров `project_search`**, а не сравнение
mock-выдачи и не утверждение семантического паритета. Production-поиск не изменён.

## Запуск

Из корня проекта; нужны установленные зависимости root/tools-suite, Node с
`node:sqlite`, `tsx`, `git`, `/usr/bin/time` и установленный `idx`:

```sh
npm --prefix external/pi-tools-suite run benchmark:search:test
# Без сети/embeddings: только native lexical, IDX/semantic не измеряются.
node external/pi-tools-suite/benchmarks/repository-search/run.mjs --repeats 1

# ТОЛЬКО после отдельного согласия на передачу текстов и расходы:
node external/pi-tools-suite/benchmarks/repository-search/run.mjs \
  --paid --repeats 3 --out .pi/artifacts/search-benchmark-final

# Повторная оценка сохранённых ответов: без сети и без новых embeddings.
node external/pi-tools-suite/benchmarks/repository-search/analyze.mjs \
  .pi/artifacts/search-benchmark-final
```

Выходной каталог должен быть новым, под `.pi/artifacts/`. Повторный запуск требует
другого `--out`. Чтобы повторить **те же байты**, используйте сохранённый снимок:

```sh
node external/pi-tools-suite/benchmarks/repository-search/run.mjs \
  --paid --repeats 3 \
  --from .pi/artifacts/search-benchmark-final/native \
  --out .pi/artifacts/search-benchmark-repeat
```

Снимок source сохраняет исходные файлы корпуса; lifecycle изменяет только специально
добавленные probe-файлы. Текущие engine/CLI/платформа при повторении тоже должны
соответствовать manifest; сравните hashes и версии. Индексы для повторения создаются
заново. Существующие индексы рабочего проекта и провайдер не меняются.

`idx update` — обновление глобального пакета, **не** инкрементная индексация.
Измеряемые команды — `idx --no-auto-update init` и `idx --no-auto-update index`.
`init` сохраняет заранее скопированную конфигурацию: harness не передаёт preset,
который мог бы заменить сохранённую модель. HOME/XDG/registry изолированы.

## Корпус и qrels

- Фиксированный подкорпус из текущего рабочего дерева, не только HEAD: 18 файлов,
  174 642 байта. Реальные относительные пути сохранены; ancestor `.gitignore`
  одинаково скопированы для обоих backend.
- 18 заранее заданных запросов: 6 точных идентификаторов, 4 документационных
  контракта, 8 русскоязычных естественных формулировок без общих точных токенов
  с английским текстом целевого файла. Нулевое пересечение Unicode-токенов
  проверяется до отправки запросов.
- Gold — путь плюс строка якоря определения/контракта, разрешённые до benchmark
  и сохранённые в `manifest.json`. Любое попадание в другой участок того же файла
  не считается строгим попаданием. Это более жёсткий критерий, чем file recall.
- `sources` ограничен доменом запроса; `limit=10`, `maxFiles=10`,
  `dedupeFile=true`, `includeContent=true` одинаковы. Это контролируемый режим,
  **не** defaults инструмента (`maxFiles=1` при includeContent).

## Метрики

- Recall@5/10 — доля gold-интервалов, перекрытых top-k; MRR — среднее обратного
  ранга первого такого попадания. Precision@10 имеет постоянный знаменатель 10,
  включая отсутствующие результаты. В этом корпусе обычно один gold на запрос.
- Валидность путей/строк — существование файла и корректные границы интервала.
  Text fidelity — совпадение нормализованного snippet/content с заявленным
  диапазоном исходного файла. Это **не** релевантность.
- Видимость якоря — доля gold-попаданий, где строка-якорь видна в возвращённом
  фрагменте, а не только попадает в широкий диапазон. Прокси полезности фрагмента,
  не полная человеческая оценка всех ответов.
- В каждой паре три повторения; первое отдельно измеряет заполнение query cache,
  два последующих образуют fully-warm выборку (36 наблюдений на backend/mode).
  Порядок backend меняется между повторами.
  Медиана и nearest-rank p95 включают создание процесса, real adapter, CLI и scan.
  Индекс прогрет, процесс каждый раз новый. Kernel page cache не сбрасывался.
- `/usr/bin/time` измеряет CPU user+system и reported peak RSS; peak RSS не равен
  суммарной одновременно занятой памяти всего дерева процессов. Размер — сумма
  файлов index directories, включая config/metadata, без очищения/compaction.
- Первичная Native-индексация совмещена с первым lexical-запросом; IDX `init`
  включает подготовку и embeddings. Эти operational timings не чистые тайминги
  одной и той же операции. Семантическое дозаполнение Native измеряется отдельно.

## Семантика и стоимость

Разрешённый пользователем предел этого измерения — $5. Оба домена используют
сохранённый `OpenRouter / perplexity/pplx-embed-v1-0.6b / 1024`, без смены провайдера.
Передаются реальные тексты кода/документов и запросы. Corpus ≤1 MiB, резервируемый
текст ≤8 MB UTF-8 и ≤1000 embedding-входов. Все прочие fetch-запросы блокируются;
LLM-классификация документов и автоматическое обновление CLI не разрешены.

Опубликованный тариф — [$0.004 / 1M input tokens](https://openrouter.ai/perplexity/pplx-embed-v1-0.6b)
([Perplexity](https://docs.perplexity.ai/docs/getting-started/pricing)). Стоимость
из usage.cost, если присутствует, отделена от оценки `usage.tokens × тариф`;
это не проверка фактического списания по счёту. Guard на 8 MB консервативно
ограничивает оценку текстовых токенов примерно $0.032, существенно ниже согласия.

IDX 2.0.16 строит vectors уже в `init/index`, даже если retrieval lexical.
Поэтому lexical latency не включает сетевой вызов поиска, но стоимость построения
IDX нельзя выдать за «чисто lexical». Native lexical вообще не делает embeddings.
Query-embedding caching и формат document inputs отличаются, даже при общей модели.

Первый Native semantic-запрос и его partial status записываются отдельно. Далее
two-domain запросы дозаполняют индекс (до 128 новых чанков на запрос, распределённых
между активными доменами). `coverage[]` содержит `indexed/total`, notices и время
каждого шага. Warm semantic/hybrid считается измеренным только при complete status
и отсутствии lexical fallback. Цена включает и corpus-, и query-embeddings.

## Ограничения и интерпретация

- Малый целевой корпус не моделирует scan большого монорепозитория, лимиты файлов,
  chunk truncation или полный ranking исходного дерева. Размер/задержка не
  экстраполируются линейно на весь проект.
- Gold размечен целевыми якорями, а не независимой полной экспертизой всех
  релевантных чанков. Возможны полезные неразмеченные результаты; strict recall
  занижается, если dedupeFile сохраняет другой чанк того же файла.
- Russian→English no-overlap cohort проверяет конкретную многоязычную семантику,
  не универсальное отсутствие лексической связи/токенизации.
- Chunking, score thresholds, candidate limits и формат embedding-текста разные.
  Контроль общей модели не устраняет эти конфаундеры.
- Freshness-сценарии проверяют lexical-публикацию после add/modify/rename/delete и
  добавления/изменения вложенного `.gitignore`; они не доказывают гонкоустойчивость,
  background refresh или полную семантическую актуальность.
- `.pi/artifacts/` может удаляться cleanup (72 часа или вручную). Для длительного
  хранения экспортируйте manifest/results/network/commands и snapshots. Сводка
  останется в этом документе; raw evidence не является долговременной гарантией.

## Измеренные результаты

Запуск: Apple M1 / 16 GiB, Darwin 23.6.0 arm64, Node v26.7.0, IDX 2.0.16.
HEAD `b489d7899bb8f0baa0cd7fee540ecff9117aa3d5` плюс рабочие изменения;
точные SHA-256 корпуса и 20 файлов search-engine сохранены в manifest.
384 командных измерения, 361 query-наблюдение, 12 freshness-проверок.

Сырой runner исходной версии завершил все фазы, но вернул exit 1 из-за найденной
ошибки backend. Это не оборванное измерение. Offline analyzer проверил число
наблюдений, нулевые exit codes дочерних команд и неизменность snapshot:
`executionComplete=true`, `freshnessPassed=false`. Теперь runner разделяет
завершённость эксперимента и обнаруженные нарушения freshness. Исходный
`results.json` не переписан; исправление учёта многоточия в snippet применено
offline и проверено тестом.

### Retrieval и fully-warm задержка

| Backend / mode | Recall@5 | Recall@10 | MRR | P@10 | median / p95, ms | median CPU, ms | peak RSS, MiB |
|---|---:|---:|---:|---:|---:|---:|---:|
| Native lexical | 0.333 | 0.333 | 0.250 | 0.033 | 950 / 1380 | 1410 | 200.9 |
| IDX lexical | 0.500 | 0.500 | 0.417 | 0.050 | 1420 / 1956 | 1930 | 201.8 |
| Native hybrid | 0.611 | 0.722 | 0.423 | 0.072 | 1232 / 1728 | 1760 | 200.8 |
| IDX hybrid | 0.667 | 0.667 | 0.583 | 0.067 | 2281 / 2694 | 2430 | 201.7 |
| Native semantic | 0.611 | 0.667 | 0.497 | 0.067 | 1188 / 1942 | 1760 | 200.5 |
| IDX semantic | 0.667 | 0.667 | 0.611 | 0.067 | 2118 / 3093 | 2380 | 201.5 |

Первое прохождение hybrid-запросов с уже построенным corpus index, но ещё не
заполненным query cache: Native median/p95 **1664/2092 ms**, IDX **2126/6935 ms**.
Не следует смешивать эти наблюдения с fully-warm столбцом.

Раздельный Recall@10 (одна и та же строгая gold-разметка):

| Backend / mode | Код, 10 запросов | Документы, 8 | Идентификаторы, 6 | Контракты, 4 | NL без общих токенов, 8 |
|---|---:|---:|---:|---:|---:|
| Native lexical | 0.200 | 0.500 | 0.333 | 1.000 | 0.000 |
| IDX lexical | 0.500 | 0.500 | 0.833 | 1.000 | 0.000 |
| Native hybrid | 0.800 | 0.625 | 0.667 | 0.750 | 0.750 |
| IDX hybrid | 0.600 | 0.750 | 0.833 | 1.000 | 0.375 |
| Native semantic | 0.800 | 0.500 | 0.667 | 0.500 | 0.750 |
| IDX semantic | 0.700 | 0.625 | 0.833 | 0.750 | 0.500 |

### Полезность фрагментов и точность координат

Все возвращённые пути существуют. Более строгая проверка интервала/текста:

| Backend / mode | Валидные диапазоны | Text fidelity | Видимый gold-якорь среди gold-попаданий |
|---|---:|---:|---:|
| Native lexical | 100% | 100% | 50.0% |
| IDX lexical | 93.5% | 63.0% | 66.7% |
| Native hybrid | 100% | 100% | 38.5% |
| IDX hybrid | 95.6% | 84.6% | 66.7% |
| Native semantic | 100% | 100% | 50.0% |
| IDX semantic | 93.1% | 93.1% | 83.3% |

Например, IDX для `id-parser` возвращает `native.ts:49–66`, хотя файл содержит
64 строки; текст snippet начинается раньше заявленной строки. Другой результат
`native-embedding-provider.mjs:18–55` включает комментарий выше начала интервала.
Метрика удаляет служебный префикс `Lines … ·` и добавленное preview-многоточие,
но не исправляет координаты backend. Native возвращает корректный диапазон,
однако широкий chunk и preview часто не показывают сам gold-якорь: корректные
координаты не гарантируют полезность фрагмента.

### Индексация, coverage, размер и стоимость

| Операция | Wall, ms | CPU, ms | reported peak RSS, MiB |
|---|---:|---:|---:|
| Native: пустой индекс → первый lexical ответ | 1389 | 1400 | 192.7 |
| IDX: `init`, включая embeddings | 5192 | 1400 | 269.8 |
| IDX: первый lexical ответ после init | 1346 | 1790 | 197.0 |
| Native: первый semantic ответ, code scope 40/40 | 3036 | 1350 | 195.8 |
| Native: backfill обоих доменов, 104/106 | 2879 | 1310 | 218.5 |
| Native: следующий backfill, 106/106 | 1157 | 1200 | 215.9 |

Native имеет 40 code и 66 document чанков. После code-only запроса обе-domain
операция ограничена 64 чанками на домен: первые 64 документа дают **partial**
104/106, ещё два дают fully ready. Это реальное измерение дозаполнения; корпус
в целом **меньше 128**, поэтому жёсткий потолок 128 на большем single-domain
корпусе здесь не измерен. Первый code-only ответ complete в своём scope, не во
всём corpus. IDX строит свой иначе нарезанный vector corpus при init.

| Состояние | Native index, bytes | IDX storage, bytes |
|---|---:|---:|
| После lexical pass | 704 559 | 5 244 846 |
| После всех warm retrieval pass, до probe-изменений | 1 323 055 | 6 129 582 |

Размер IDX в lexical строке уже включает vectors; это не сравнение двух чистых
lexical структур. Native `.indexer-cli/config.json` (388 bytes) не включён в его
search index; IDX `.pi` (47 bytes) также не включён в IDX storage.

| Backend, все фазы финального запуска | Embedding HTTP | Входов | UTF-8 bytes | Tokens | usage.cost, USD |
|---|---:|---:|---:|---:|---:|
| Native | 26 | 124 | 202 753 | 47 253 | 0.000189012 |
| IDX | 129 | 403 | 366 218 | 85 203 | 0.000340812 |

Все 155 ответов содержали usage; оценка по опубликованному тарифу совпадает с
суммой `usage.cost` (**$0.000529824**). Это не банковская сверка. Предшествующая
оборванная попытка дополнительно дала $0.000355324; обе попытки вместе
$0.000885148, ниже согласованных $5. Остальные прогоны/tests не делали платных
вызовов. IDX также попытался сделать **32** запроса классификатора документов
через OpenRouter `alpha/decisions` (тот использует embedding API key); guard
заблокировал их **до сети**, поскольку отдельного согласия на LLM нет. Это
ограничение сравнения с полностью включённым advisory-классификатором IDX, а не
доказательство паритета классификации.

### Изменения файлов и nested ignore

Probe — `search-benchmark-probes/nested/{before,renamed}.ts`. Native публикует
изменение внутри запроса; IDX сначала получает явный `index`, затем запрос.
Тайминги нельзя выдавать за одинаковые чистые операции.

| Изменение | Native refresh+query, ms / результат | IDX index, ms | IDX query, ms / результат |
|---|---:|---:|---:|
| Добавление | 1041 / OK | 1253 | 1494 / OK |
| Изменение содержимого | 1366 / OK | 1238 | 1663 / OK |
| Переименование | 1103 / OK | 1139 | 1681 / OK |
| Добавление nested `.gitignore`: `renamed.ts` | 1376 / OK | 857 | 1725 / **FAIL: исключённый файл ещё в выдаче** |
| Изменение ignore: убрать правило | 1083 / OK | 710 | 1694 / OK |
| Удаление | 1217 / OK | 807 | 1490 / OK |

CPU/RSS incremental-операций: Native refresh+query **1570–1870 ms / 191.2–200.3
MiB**, IDX index **760–920 ms / 158.7–175.8 MiB**. У IDX query — отдельная операция.
Все `idx index` вернули exit 0, включая не удалившее исключённый результат.
Проверка freshness не заменяет regression-тест всех расширений/доменов/режимов.

## Рекомендации

1. Native lexical: повысить exact-symbol ranking и выбирать definition-bearing
   chunk **до** file dedupe. В этой выборке native уступает IDX на идентификаторах,
   хотя быстрее примерно в 1.5 раза и требует меньшего index storage.
2. Native previews: показывать окно вокруг query/gold-подобного совпадения,
   не только начало широкого chunk; сохранить точность path/line.
3. Native semantic: сохранить bounded upload и явные notices, добавить отдельный
   benchmark >128 чанков на домен и большого рабочего дерева. Предсказуемый
   explicit backfill полезнее скрытого фонового платного заполнения.
4. IDX: проверить invalidation при изменении ignore, удалять теперь исключённые
   документы; исправить line offsets/end bounds чанков и покрыть реальными fixtures.
5. Сократить process/CLI overhead обоих адаптеров; measured peak RSS почти одинаков
   (~201 MiB), несмотря на сильно различающийся размер индексов. Оптимизировать
   scan только после отдельного большого snapshot benchmark, не по этим 18 файлам.
6. Не переключать default backend на основании этой таблицы: IDX лучше по MRR и
   идентификаторам, native — по скорости и этой NL cohort. Нужны независимые qrels,
   больше языков/репозиториев, cold-page-cache и semantic freshness измерения.

## Evidence и проверки

- [Manifest / hashes / qrels](../../.pi/artifacts/search-benchmark-final/manifest.json)
- [Исходные ответы и команды](../../.pi/artifacts/search-benchmark-final/results.json)
- [Offline-анализ с исправленным учётом preview](../../.pi/artifacts/search-benchmark-final/analysis.json)
- [Embedding usage, без текстов и ключей](../../.pi/artifacts/search-benchmark-final/network.jsonl)
- [Regression tests поиска](../../.pi/artifacts/search-benchmark-check/search-regression.log): 49 tests, 264 assertions, pass.
- Suite typecheck — pass; benchmark metric/guard/analyzer tests — см. актуальный
  [лог](../../.pi/artifacts/search-benchmark-check/metrics-tests-final.log).
- `npm run check:ci`: root/ACP/Desktop check/tests прошли; **blocked/failed** на
  `cargo fmt --check` из-за уже существовавших изменений вне задачи в
  `desktop/src-tauri/src/{lib.rs,search_index_status.rs}`. Полный CI pass не заявлен:
  [summary](../../.pi/artifacts/check-ci-g7v0H0/summary.json),
  [rust-fmt log](../../.pi/artifacts/check-ci-g7v0H0/rust-fmt.log).
