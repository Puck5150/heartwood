<script lang="ts">
  let {
    content,
    onChange,
  }: {
    content: string;
    onChange: (content: string) => void;
  } = $props();
</script>

<div class="session-notes">
  <label for="session-notes-textarea">Notes</label>
  <textarea
    id="session-notes-textarea"
    value={content}
    oninput={(event) => onChange(event.currentTarget.value)}
    placeholder="Jot down anything about this session…"
    rows="4"
  ></textarea>
</div>

<style>
  .session-notes {
    margin-top: 1.5rem;
    padding: 1.25rem;
    border-radius: 1rem;
    background: var(--surface-secondary);
  }

  label {
    display: block;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    margin-bottom: 0.5rem;
  }

  textarea {
    width: 100%;
    box-sizing: border-box;
    padding: 0.6rem 0.75rem;
    border-radius: 0.6rem;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    font-size: 0.9rem;
    font-family: inherit;
    resize: vertical;
    min-height: 5rem;
  }

  textarea:focus {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
</style>
