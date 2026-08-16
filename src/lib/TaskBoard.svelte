<script lang="ts">
  import { PRIORITY_LABELS, STATUS_LABELS, TASK_PRIORITIES, TASK_STATUSES, type Task, type TaskPriority, type TaskStatus } from './tasks';

  let {
    tasks,
    onCreateTask,
    onUpdateTask,
    onDeleteTask,
  }: {
    tasks: Task[];
    onCreateTask: (fields: { title: string; notes: string | null; priority: TaskPriority; dueAt: number | null }) => Promise<void>;
    onUpdateTask: (
      id: string,
      fields: { title: string; notes: string | null; priority: TaskPriority; dueAt: number | null },
    ) => Promise<void>;
    onDeleteTask: (id: string) => Promise<void>;
  } = $props();

  function tasksFor(status: TaskStatus): Task[] {
    return tasks.filter((t) => t.status === status);
  }

  function isOverdue(task: Task): boolean {
    return task.dueAt !== null && task.status !== 'done' && task.dueAt < Date.now();
  }

  function dateInputValue(ms: number | null): string {
    if (ms === null) return '';
    const date = new Date(ms);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  /** Local midnight for the chosen calendar day — a due date is date-only,
   * never a specific moment (see the plan's Global Constraints). */
  function parseDateInput(value: string): number | null {
    if (!value) return null;
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day).getTime();
  }

  let addingTask = $state(false);
  let newTitle = $state('');
  let newNotes = $state('');
  let newPriority = $state<TaskPriority>('medium');
  let newDueDate = $state('');

  function startAddTask() {
    addingTask = true;
  }

  function cancelAddTask() {
    addingTask = false;
    newTitle = '';
    newNotes = '';
    newPriority = 'medium';
    newDueDate = '';
  }

  async function submitNewTask() {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    await onCreateTask({
      title: trimmed,
      notes: newNotes.trim() || null,
      priority: newPriority,
      dueAt: parseDateInput(newDueDate),
    });
    cancelAddTask();
  }

  let editingTaskId = $state<string | null>(null);
  let editTitle = $state('');
  let editNotes = $state('');
  let editPriority = $state<TaskPriority>('medium');
  let editDueDate = $state('');
  let confirmingDeleteId = $state<string | null>(null);

  function openTask(task: Task) {
    editingTaskId = task.id;
    editTitle = task.title;
    editNotes = task.notes ?? '';
    editPriority = task.priority;
    editDueDate = dateInputValue(task.dueAt);
    confirmingDeleteId = null;
  }

  function closeTask() {
    editingTaskId = null;
    confirmingDeleteId = null;
  }

  async function submitEditTask() {
    if (!editingTaskId) return;
    const trimmed = editTitle.trim();
    if (!trimmed) return;
    await onUpdateTask(editingTaskId, {
      title: trimmed,
      notes: editNotes.trim() || null,
      priority: editPriority,
      dueAt: parseDateInput(editDueDate),
    });
    closeTask();
  }

  async function confirmDeleteTask() {
    if (!confirmingDeleteId) return;
    await onDeleteTask(confirmingDeleteId);
    closeTask();
  }
</script>

<div class="board">
  {#each TASK_STATUSES as status (status)}
    <div class="column">
      <h3 class="column-title">{STATUS_LABELS[status]}</h3>
      {#if status === 'backlog'}
        {#if addingTask}
          <div class="create-form">
            <input type="text" placeholder="Task title" bind:value={newTitle} aria-label="New task title" />
            <textarea placeholder="Notes (optional)" bind:value={newNotes} aria-label="New task notes"></textarea>
            <div class="priority-radios" role="radiogroup" aria-label="Priority">
              {#each TASK_PRIORITIES as priority (priority)}
                <label>
                  <input type="radio" name="new-task-priority" value={priority} bind:group={newPriority} />
                  {PRIORITY_LABELS[priority]}
                </label>
              {/each}
            </div>
            <input type="date" bind:value={newDueDate} aria-label="New task due date" />
            <div class="create-actions">
              <button type="button" class="link" onclick={cancelAddTask}>Cancel</button>
              <button type="button" class="link" onclick={submitNewTask}>Create</button>
            </div>
          </div>
        {:else}
          <button type="button" class="link add-task" onclick={startAddTask}>+ Add task</button>
        {/if}
      {/if}
      <ul>
        {#each tasksFor(status) as task (task.id)}
          <li>
            <button type="button" class="card" onclick={() => openTask(task)}>
              <span class="title">{task.title}</span>
              <span class="tags">
                <span class="pill priority-{task.priority}">{PRIORITY_LABELS[task.priority]}</span>
                {#if task.dueAt !== null}
                  <span class="due" class:overdue={isOverdue(task)}>{new Date(task.dueAt).toLocaleDateString()}</span>
                {/if}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    </div>
  {/each}
</div>

{#if editingTaskId}
  <div class="task-detail" role="dialog" aria-label="Edit task">
    <input type="text" bind:value={editTitle} aria-label="Task title" />
    <textarea bind:value={editNotes} aria-label="Task notes"></textarea>
    <div class="priority-radios" role="radiogroup" aria-label="Priority">
      {#each TASK_PRIORITIES as priority (priority)}
        <label>
          <input type="radio" name="edit-task-priority" value={priority} bind:group={editPriority} />
          {PRIORITY_LABELS[priority]}
        </label>
      {/each}
    </div>
    <input type="date" bind:value={editDueDate} aria-label="Task due date" />

    {#if confirmingDeleteId === editingTaskId}
      <div class="row-confirm">
        <span class="row-confirm-text">Delete this task?</span>
        <button type="button" class="link" onclick={() => (confirmingDeleteId = null)}>Cancel</button>
        <button type="button" class="link danger" onclick={confirmDeleteTask}>Confirm</button>
      </div>
    {:else}
      <div class="detail-actions">
        <button type="button" class="link danger" onclick={() => (confirmingDeleteId = editingTaskId)}>Delete</button>
        <button type="button" class="link" onclick={closeTask}>Cancel</button>
        <button type="button" class="link" onclick={submitEditTask}>Save</button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .board {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 1rem;
    align-items: start;
  }

  .column {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem;
    border-radius: 0.5rem;
    background: var(--surface-secondary);
  }

  .column-title {
    margin: 0;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text-muted);
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    width: 100%;
    padding: 0.65rem 0.8rem;
    border: none;
    border-radius: 0.5rem;
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
    text-align: left;
  }

  .title {
    font-weight: 600;
    font-size: 0.85rem;
  }

  .tags {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .pill {
    font-size: 0.72rem;
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
    background: var(--surface-secondary);
    color: var(--text-muted);
  }

  .priority-high {
    font-weight: 700;
  }

  .due {
    font-size: 0.72rem;
    color: var(--text-muted);
  }

  .due.overdue {
    color: var(--danger);
  }

  .add-task {
    align-self: flex-start;
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

  .create-form,
  .task-detail {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem;
    border-radius: 0.5rem;
    background: var(--surface);
  }

  .task-detail {
    margin-top: 1rem;
    background: var(--surface-secondary);
  }

  .create-form input[type='text'],
  .create-form textarea,
  .task-detail input[type='text'],
  .task-detail textarea {
    font: inherit;
    padding: 0.4rem 0.6rem;
    border-radius: 0.4rem;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
  }

  .priority-radios {
    display: flex;
    gap: 1rem;
    font-size: 0.85rem;
    color: var(--text);
  }

  .priority-radios label {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }

  .create-actions,
  .detail-actions {
    display: flex;
    justify-content: flex-end;
    gap: 1rem;
  }

  .row-confirm {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
  }

  .row-confirm-text {
    font-size: 0.8rem;
    color: var(--text-muted);
  }
</style>
