<script lang="ts">
  import type { ComponentProps } from "svelte";
  import StatusBar from "./StatusBar.svelte";

  let { props }: { props: ComponentProps<typeof StatusBar> } = $props();
</script>

<StatusBar {...props} />
