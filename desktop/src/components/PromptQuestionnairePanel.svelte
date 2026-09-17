<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import Eye from "@lucide/svelte/icons/eye";
  import X from "@lucide/svelte/icons/x";
  import {
    questionDraftIsComplete,
    type DesktopQuestion,
    type QuestionComposerMode,
    type QuestionDraft,
  } from "../lib/question";

  let {
    questionMode,
    previewing,
    allQuestionsComplete,
    currentQuestion,
    currentDraft,
    currentSelectionCount,
    selectedChoiceIndex,
    answerLabel,
    onSelectTab,
    onEditAnswer,
    onChooseChoice,
    onChooseCustom,
    onTabKeydown,
    onChoiceKeydown,
  }: {
    questionMode: QuestionComposerMode;
    previewing: boolean;
    allQuestionsComplete: boolean;
    currentQuestion: DesktopQuestion | undefined;
    currentDraft: QuestionDraft | undefined;
    currentSelectionCount: number;
    selectedChoiceIndex: number;
    answerLabel: (question: DesktopQuestion) => string;
    onSelectTab: (index: number) => void;
    onEditAnswer: (index: number) => void;
    onChooseChoice: (choiceValue: string) => void;
    onChooseCustom: () => void;
    onTabKeydown: (event: KeyboardEvent, index: number) => void;
    onChoiceKeydown: (event: KeyboardEvent, index: number) => void;
  } = $props();
</script>

<div class="border-b border-border bg-panel px-3 pt-2.5">
  <div class="mb-2 flex items-center justify-between gap-3">
    <p class="min-w-0 truncate text-xs font-medium text-muted-foreground">{questionMode.message}</p>
    <button
      class="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      type="button"
      aria-label="Cancel questions"
      title="Cancel questions"
      onclick={questionMode.onCancel}
    ><X class="size-3.5" aria-hidden="true" /></button>
  </div>
  <div class="flex min-w-0 gap-1 overflow-x-auto" role="tablist" aria-label="Questions">
    {#each questionMode.questions as question, index}
      {@const complete = questionDraftIsComplete(questionMode.state.drafts[question.id], question)}
      <button
        class={[
          "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-t-md border-x border-t px-2.5 text-xs font-medium transition-colors focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-ring",
          questionMode.state.activeTab === index
            ? "border-border bg-panel-strong text-foreground"
            : "border-transparent text-muted-foreground hover:bg-panel-hover hover:text-foreground",
        ]}
        type="button"
        role="tab"
        id={`question-composer-tab-${index}`}
        data-question-tab={index}
        aria-selected={questionMode.state.activeTab === index}
        aria-controls="question-composer-panel"
        tabindex={questionMode.state.activeTab === index ? 0 : -1}
        onclick={() => onSelectTab(index)}
        onkeydown={(event) => onTabKeydown(event, index)}
      >
        <span class="grid size-3 shrink-0 place-items-center" aria-hidden="true">
          {#if complete}<Check class="size-3 text-primary" strokeWidth={2.25} />{/if}
        </span>
        <span>{question.label}</span>
      </button>
    {/each}
    <button
      class={[
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-t-md border-x border-t px-2.5 text-xs font-medium transition-colors focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-ring",
        previewing
          ? "border-border bg-panel-strong text-foreground"
          : "border-transparent text-muted-foreground hover:bg-panel-hover hover:text-foreground",
      ]}
      type="button"
      role="tab"
      id={`question-composer-tab-${questionMode.questions.length}`}
      data-question-tab={questionMode.questions.length}
      aria-selected={previewing}
      aria-controls="question-composer-panel"
      tabindex={previewing ? 0 : -1}
      onclick={() => onSelectTab(questionMode.questions.length)}
      onkeydown={(event) => onTabKeydown(event, questionMode.questions.length)}
    ><Eye class="size-3" aria-hidden="true" />Preview</button>
  </div>
</div>

<div
  id="question-composer-panel"
  class="max-h-[min(52vh,32rem)] overflow-y-auto px-3 pt-3"
  role="tabpanel"
  aria-labelledby={`question-composer-tab-${questionMode.state.activeTab}`}
>
  {#if previewing}
    <div class="mb-3 flex items-start justify-between gap-4">
      <div>
        <p class="text-sm font-semibold text-foreground">Preview answers</p>
        <p class="mt-0.5 text-xs text-muted-foreground">Review every answer before sending.</p>
      </div>
      <span class={[
        "rounded-full px-2 py-0.5 text-xs font-semibold",
        allQuestionsComplete ? "bg-primary/10 text-primary" : "bg-destructive/10 text-destructive",
      ]}>{allQuestionsComplete ? "Ready" : "Incomplete"}</span>
    </div>
    <div class="mb-3 divide-y divide-border/70 border-t border-border/70">
      {#each questionMode.questions as question, index}
        {@const complete = questionDraftIsComplete(questionMode.state.drafts[question.id], question)}
        <button
          class={[
            "group flex w-full items-start gap-2.5 px-2 py-2 text-left transition-colors focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-ring",
            complete ? "hover:bg-panel-hover" : "bg-destructive/5 hover:bg-destructive/10",
          ]}
          type="button"
          onclick={() => onEditAnswer(index)}
        >
          <span class={[
            "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full",
            complete ? "bg-primary/10 text-primary" : "bg-destructive/10 text-destructive",
          ]}>{#if complete}<Check class="size-2.5" strokeWidth={2.4} />{:else}<span class="text-xs leading-none">!</span>{/if}</span>
          <span class="min-w-0 flex-1">
            <span class="block text-xs font-semibold text-foreground">{question.label}</span>
            <span class={[
              "mt-0.5 block text-xs whitespace-pre-wrap break-words",
              complete ? "text-muted-foreground" : "font-medium text-destructive",
            ]}>{answerLabel(question)}</span>
          </span>
          <span class="text-xs font-medium text-muted-foreground group-hover:text-foreground">Edit</span>
        </button>
      {/each}
    </div>
  {:else if currentQuestion && currentDraft}
    {@const maxSelections = currentQuestion.maxSelections ?? currentQuestion.choices.length + 1}
    {@const atSelectionLimit = currentQuestion.multiple && currentSelectionCount >= maxSelections}
    <div class="mb-3 flex items-start justify-between gap-3">
      <div class="min-w-0">
        <p class="text-sm leading-relaxed font-medium whitespace-pre-wrap text-foreground">{currentQuestion.prompt}</p>
        {#if currentQuestion.multiple}
          <p id="question-selection-hint" class="mt-1 text-xs text-muted-foreground" aria-live="polite">
            Select {currentQuestion.minSelections ?? 1}–{maxSelections} answers · {currentSelectionCount} selected
          </p>
        {/if}
      </div>
      <span class="mt-0.5 shrink-0 text-xs tabular-nums text-muted-foreground">{questionMode.state.activeTab + 1}/{questionMode.questions.length}</span>
    </div>
    <div
      class="mb-3 divide-y divide-border/70 border-t border-border/70"
      role={currentQuestion.multiple ? "group" : "radiogroup"}
      aria-label={currentQuestion.label}
      aria-describedby={currentQuestion.multiple ? "question-selection-hint" : undefined}
    >
      {#each currentQuestion.choices as choice, choiceIndex}
        {@const selected = currentDraft.choiceValues.includes(choice.value)}
        {@const blocked = atSelectionLimit && !selected}
        <button
          class={[
            "flex w-full items-start gap-2.5 px-2 py-2 text-left transition-colors focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-ring",
            selected ? "bg-panel-selected" : "hover:bg-panel-hover",
            blocked && "cursor-not-allowed opacity-45",
          ]}
          type="button"
          role={currentQuestion.multiple ? "checkbox" : "radio"}
          data-question-choice={choiceIndex}
          aria-checked={selected}
          aria-disabled={blocked || undefined}
          tabindex={selectedChoiceIndex === choiceIndex ? 0 : -1}
          onclick={() => onChooseChoice(choice.value)}
          onkeydown={(event) => onChoiceKeydown(event, choiceIndex)}
        >
          <span class={[
            "mt-0.5 grid size-4 shrink-0 place-items-center border",
            currentQuestion.multiple ? "rounded-sm" : "rounded-full",
            selected ? "border-primary" : "border-muted-foreground/50",
          ]}>{#if selected}{#if currentQuestion.multiple}<Check class="size-3 text-primary" strokeWidth={2.4} />{:else}<span class="size-2 rounded-full bg-primary"></span>{/if}{/if}</span>
          <span class="min-w-0">
            <span class="block text-xs font-medium text-foreground">{choice.label}</span>
            {#if choice.description}<span class="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{choice.description}</span>{/if}
          </span>
        </button>
      {/each}
      <button
        class={[
          "flex w-full items-start gap-2.5 px-2 py-2 text-left transition-colors focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-ring",
          currentDraft.customSelected ? "bg-panel-selected" : "hover:bg-panel-hover",
          atSelectionLimit && !currentDraft.customSelected && "cursor-not-allowed opacity-45",
        ]}
        type="button"
        role={currentQuestion.multiple ? "checkbox" : "radio"}
        data-question-choice={currentQuestion.choices.length}
        aria-checked={currentDraft.customSelected}
        aria-disabled={(atSelectionLimit && !currentDraft.customSelected) || undefined}
        tabindex={selectedChoiceIndex === currentQuestion.choices.length ? 0 : -1}
        onclick={onChooseCustom}
        onkeydown={(event) => onChoiceKeydown(event, currentQuestion.choices.length)}
      >
        <span class={[
          "mt-0.5 grid size-4 shrink-0 place-items-center border",
          currentQuestion.multiple ? "rounded-sm" : "rounded-full",
          currentDraft.customSelected ? "border-primary" : "border-muted-foreground/50",
        ]}>{#if currentDraft.customSelected}{#if currentQuestion.multiple}<Check class="size-3 text-primary" strokeWidth={2.4} />{:else}<span class="size-2 rounded-full bg-primary"></span>{/if}{/if}</span>
        <span class="text-xs font-medium text-foreground">Something else…</span>
      </button>
    </div>
  {/if}
</div>
