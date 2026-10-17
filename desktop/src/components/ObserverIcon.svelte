<script lang="ts">
  let { class: className = "", ...rest }: { class?: unknown; [key: string]: unknown } = $props();
</script>

<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class={className as string} {...rest}>
  <path d="M13.73 4a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
  <path fill="currentColor" fill-rule="evenodd" stroke-width="1"
    d="M7.75 14Q12 9.5 16.25 14Q12 18.5 7.75 14ZM10.6 14a1.4 1.4 0 1 0 2.8 0a1.4 1.4 0 1 0-2.8 0Z" />
</svg>
