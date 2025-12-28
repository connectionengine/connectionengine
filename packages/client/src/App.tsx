import { createSignal, onMount, onCleanup } from 'solid-js';
import { SHARED_CONSTANT } from '@connectionengine/core';

export default function App() {
  const [message, setMessage] = createSignal('Loading...');

  const fetchData = async () => {
    try {
      const res = await fetch('http://localhost:3001/health');
      const data = (await res.json()) as { message: string; status: string };
      setMessage(data.message + ' ' + data.status);
    } catch {
      setMessage('Error fetching data');
    }
  };

  onMount(() => {
    void fetchData();
    const interval = setInterval(() => {
      void fetchData();
    }, 5000);
    onCleanup(() => clearInterval(interval));
  });

  return (
    <div class="p-4">
      <h1 class="text-2xl font-bold">Client</h1>
      <p>Shared: {SHARED_CONSTANT}</p>
      <p>Server: {message()}</p>
    </div>
  );
}
