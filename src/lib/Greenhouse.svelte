<script lang="ts">
  import type { ParkedThought } from './parkingLot';

  const NOTE_AUTOSAVE_DEBOUNCE_MS = 600;

  let {
    thoughts,
    disabled = false,
    onPlant,
    onStart,
    onDelete,
    onUpdateNote,
  }: {
    thoughts: ParkedThought[];
    disabled?: boolean;
    onPlant: (text: string) => void;
    onStart: (id: string) => void;
    onDelete: (id: string) => void;
    onUpdateNote: (id: string, note: string) => void;
  } = $props();

  let draft = $state('');
  let confirmingDeleteId = $state<string | null>(null);
  let expandedNoteId = $state<string | null>(null);
  let noteTimeouts = $state(new Map<string, ReturnType<typeof setTimeout>>());

  function submit(event: Event) {
    event.preventDefault();
    if (disabled || !draft.trim()) return;
    onPlant(draft);
    draft = '';
  }

  function toggleNote(id: string) {
    expandedNoteId = expandedNoteId === id ? null : id;
  }

  function scheduleNoteUpdate(id: string, note: string) {
    const existing = noteTimeouts.get(id);
    if (existing) clearTimeout(existing);
    noteTimeouts.set(
      id,
      setTimeout(() => {
        noteTimeouts.delete(id);
        onUpdateNote(id, note);
      }, NOTE_AUTOSAVE_DEBOUNCE_MS),
    );
  }

  function handleNoteInput(id: string, event: Event) {
    const value = (event.currentTarget as HTMLTextAreaElement).value;
    scheduleNoteUpdate(id, value);
  }
</script>

<section class="greenhouse" aria-labelledby="greenhouse-heading">
  <h1 id="greenhouse-heading">Greenhouse</h1>

  <form onsubmit={submit}>
    <input
      type="text"
      placeholder="Plant a thought…"
      bind:value={draft}
      aria-label="Plant a thought"
      {disabled}
    />
    <button type="submit" disabled={disabled || !draft.trim()}>Plant</button>
  </form>

  {#if thoughts.length === 0}
    <p class="empty">Nothing planted yet.</p>
  {:else}
    <ul>
      {#each thoughts as thought (thought.id)}
        <li>
          <div class="row-top">
            <span class="text">{thought.text}</span>
            {#if confirmingDeleteId === thought.id}
              <div class="row-confirm">
                <span class="row-confirm-text">Delete this thought?</span>
                <button class="link" onclick={() => (confirmingDeleteId = null)}>Cancel</button>
                <button
                  class="link danger"
                  onclick={() => {
                    onDelete(thought.id);
                    confirmingDeleteId = null;
                  }}
                >
                  Confirm
                </button>
              </div>
            {:else}
              <div class="row-actions">
                <button type="button" class="link" onclick={() => toggleNote(thought.id)}>
                  {thought.note ? 'Edit note' : 'Add note'}
                </button>
                <button
                  type="button"
                  aria-label={`Start focus: ${thought.text}`}
                  {disabled}
                  onclick={() => onStart(thought.id)}
                >
                  Start
                </button>
                <button class="link danger" onclick={() => (confirmingDeleteId = thought.id)}>
                  Delete
                </button>
              </div>
            {/if}
          </div>
          {#if expandedNoteId === thought.id}
            <textarea
              class="note"
              placeholder="Jot a note about this thought…"
              aria-label={`Note for: ${thought.text}`}
              value={thought.note ?? ''}
              oninput={(event) => handleNoteInput(thought.id, event)}
            ></textarea>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .greenhouse {
    width: min(100%, 40rem);
    margin: 0 auto;
    padding: 1.5rem 1rem;
  }

  h1 {
    margin: 0 0 1rem;
    font-size: 1.3rem;
    color: var(--text);
  }

  form {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1.25rem;
  }

  input {
    flex: 1;
    padding: 0.6rem 0.85rem;
    border-radius: 0.5rem;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    font-size: 0.95rem;
  }

  input:focus {
    outline: 2px solid var(--timer-accent);
    outline-offset: 1px;
  }

  form button {
    padding: 0.6rem 1rem;
    border-radius: 0.5rem;
    border: none;
    background: var(--timer-accent);
    color: var(--on-timer-accent);
    font-weight: 600;
    cursor: pointer;
  }

  form button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .empty {
    color: var(--text-muted);
    font-size: 0.9rem;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  li {
    padding: 0.75rem 0.9rem;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--surface-secondary);
  }

  .row-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  .text {
    min-width: 0;
    overflow-wrap: anywhere;
    color: var(--text);
    font-size: 0.95rem;
  }

  .row-actions {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-shrink: 0;
  }

  .row-actions button:not(.link) {
    min-height: 44px;
    padding: 0.5rem 0.8rem;
    border: none;
    border-radius: 0.5rem;
    background: var(--timer-accent);
    color: var(--on-timer-accent);
    font-size: 0.85rem;
    font-weight: 700;
    cursor: pointer;
  }

  .row-actions button:disabled {
    cursor: default;
    opacity: 0.5;
  }

  .link {
    background: none;
    border: none;
    color: var(--timer-accent);
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    padding: 0;
  }

  .link.danger {
    color: var(--danger);
  }

  .row-confirm {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    flex-shrink: 0;
  }

  .row-confirm-text {
    font-size: 0.8rem;
    color: var(--text-muted);
  }

  .note {
    width: 100%;
    margin-top: 0.6rem;
    padding: 0.5rem 0.65rem;
    border-radius: 0.5rem;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    font-size: 0.85rem;
    font-family: inherit;
    resize: vertical;
    min-height: 3.5rem;
  }

  .note:focus {
    outline: 2px solid var(--timer-accent);
    outline-offset: 1px;
  }
</style>
