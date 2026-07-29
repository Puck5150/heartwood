<script lang="ts">
  let {
    task,
    onBreak,
    onFlow,
    onFinish,
  }: {
    task: string;
    onBreak: () => void;
    onFlow: () => void;
    onFinish: () => void;
  } = $props();
</script>

<section class="decision">
  <p class="eyebrow">Focus check</p>
  <h1>Your planned session is complete.</h1>
  <p class="task">{task}</p>

  <div class="choices">
    <button onclick={onBreak}>Take a break</button>
    <button onclick={onFlow}>Continue in flow</button>
    <button class="primary" onclick={onFinish}>Finish session</button>
  </div>
</section>

<style>
  .decision {
    text-align: center;
    padding: 3rem 2rem;
    border-radius: 1.25rem;
    background: var(--surface);
    box-shadow: var(--shadow);
  }

  .eyebrow {
    margin: 0 0 0.5rem;
    font-size: 0.85rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
  }

  h1 {
    margin: 0 0 0.5rem;
    font-size: 1.3rem;
    color: var(--text);
  }

  .task {
    margin: 0 0 2rem;
    color: var(--text-muted);
  }

  .choices {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    max-width: 20rem;
    margin: 0 auto;
  }

  button {
    padding: 0.75rem 1rem;
    border-radius: 0.7rem;
    border: 1px solid var(--border);
    background: var(--surface-secondary);
    color: var(--text);
    font-size: 1rem;
    font-weight: 500;
    cursor: pointer;
  }

  button.primary {
    background: var(--timer-accent);
    border-color: var(--timer-accent);
    color: var(--on-timer-accent);
    font-weight: 600;
  }
</style>
