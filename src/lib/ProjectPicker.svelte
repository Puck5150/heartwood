<script lang="ts">
  import { untrack } from 'svelte';
  import { CATEGORY_LABELS, PROJECT_CATEGORIES, isSelectable, type Project, type ProjectCategory } from './projects';

  let {
    projects,
    selectedId,
    onSelect,
    onCreate,
    initiallyCreating = false,
  }: {
    projects: Project[];
    selectedId: string | null;
    onSelect: (id: string | null) => void;
    onCreate: (name: string, category: ProjectCategory) => Promise<Project>;
    /** Skips straight to the create form instead of the dropdown — used by
     * Projects.svelte's "+ New Project" button, where showing a dropdown
     * (with nothing sensible to select yet) before the create form would
     * be a confusing extra click. */
    initiallyCreating?: boolean;
  } = $props();

  // Deliberately snapshots only the initial prop value — see initiallyCreating's
  // doc comment above; a later prop change shouldn't yank the user out of an
  // in-progress create form back to the dropdown.
  let creating = $state(untrack(() => initiallyCreating));
  let newName = $state('');
  let newCategory = $state<ProjectCategory>('personal');
  let createError = $state<string | null>(null);

  // Includes the currently-selected project even if archived, so the
  // <select> always has a matching <option> for selectedId — otherwise the
  // browser falls back to selectedIndex = -1 (nothing shown as selected)
  // for a session tagged with a project archived after the fact. The
  // dropdown's *offered* options for picking something new are still
  // limited to isSelectable via this same filter.
  const selectable = $derived(projects.filter((p) => isSelectable(p) || p.id === selectedId));

  function handleChange(event: Event) {
    const value = (event.target as HTMLSelectElement).value;
    if (value === '__new__') {
      creating = true;
      return;
    }
    onSelect(value === '' ? null : value);
  }

  async function submitNewProject() {
    const trimmed = newName.trim();
    if (!trimmed) {
      createError = 'Give the project a name.';
      return;
    }
    try {
      const project = await onCreate(trimmed, newCategory);
      creating = false;
      newName = '';
      newCategory = 'personal';
      createError = null;
      onSelect(project.id);
    } catch (err) {
      console.error('Failed to create project:', err);
      createError = 'Failed to create project.';
    }
  }

  function cancelCreate() {
    creating = false;
    newName = '';
    newCategory = 'personal';
    createError = null;
  }
</script>

{#if creating}
  <div class="create-form">
    <input
      type="text"
      placeholder="Project name"
      bind:value={newName}
      aria-label="New project name"
    />
    <div class="category-radios" role="radiogroup" aria-label="Category">
      {#each PROJECT_CATEGORIES as category (category)}
        <label>
          <input type="radio" name="new-project-category" value={category} bind:group={newCategory} />
          {CATEGORY_LABELS[category]}
        </label>
      {/each}
    </div>
    {#if createError}
      <p class="error" role="alert">{createError}</p>
    {/if}
    <div class="create-actions">
      <button type="button" class="link" onclick={cancelCreate}>Cancel</button>
      <button type="button" class="link" onclick={submitNewProject}>Create</button>
    </div>
  </div>
{:else}
  <select value={selectedId ?? ''} onchange={handleChange} aria-label="Project">
    <option value="">No project</option>
    {#each selectable as project (project.id)}
      <option value={project.id}
        >{project.name} · {CATEGORY_LABELS[project.category]}{project.archivedAt !== null ? ' (archived)' : ''}</option
      >
    {/each}
    <option value="__new__">+ New project</option>
  </select>
{/if}

<style>
  select {
    font: inherit;
    padding: 0.4rem 0.6rem;
    border-radius: 0.4rem;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
  }

  .create-form {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem;
    border-radius: 0.5rem;
    background: var(--surface-secondary);
  }

  .create-form input[type='text'] {
    font: inherit;
    padding: 0.4rem 0.6rem;
    border-radius: 0.4rem;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
  }

  .category-radios {
    display: flex;
    gap: 1rem;
    font-size: 0.85rem;
    color: var(--text);
  }

  .category-radios label {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }

  .error {
    margin: 0;
    font-size: 0.8rem;
    color: var(--danger);
  }

  .create-actions {
    display: flex;
    justify-content: flex-end;
    gap: 1rem;
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
</style>
