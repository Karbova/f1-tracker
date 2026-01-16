export {};

declare global {
  interface Window {
    api: {
      listTasks: () => Promise<any[]>;
      createTask: (payload: any) => Promise<{ id: number }>;
      updateTask: (payload: any) => Promise<{ ok: true }>;
      deleteTask: (id: number) => Promise<{ ok: true }>;
      finishTask: (id: number) => Promise<{ ok: boolean }>;
      dnfTask: (id: number) => Promise<{ ok: boolean }>;
      getNextGp: () => Promise<{
        name: string;
        round: string;
        circuit?: string;
        locality?: string;
        country?: string;
        startTimeISO: string;
        source?: string;
      }>;
    };
  }
}
