import { createSignal, onCleanup, onMount } from 'solid-js'
import { fetchHealth } from '../api/health'
import HomeView from '../views/HomeView'

/**
 * The Home page component. It holds the state, and it fetches the health status
 * of the application.
 */
export default function Home() {
  const [message, setMessage] = createSignal('Loading...')

  const getData = async () => {
    try {
      const data = await fetchHealth()
      setMessage(data.message + ' ' + data.status)
    } catch {
      setMessage('Error fetching data')
    }
  }

  onMount(() => {
    void getData()
    const interval = setInterval(() => {
      void getData()
    }, 5000)
    onCleanup(() => clearInterval(interval))
  })

  return <HomeView serverMessage={message()} />
}
