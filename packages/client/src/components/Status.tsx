import type { Component } from 'solid-js'

interface StatusProps {
  message: string
  sharedConstant: string
}

/**
 * A component that shows the status messages of the client and of the server.
 */
const Status: Component<StatusProps> = (props) => {
  return (
    <div class="p-4">
      <h1 class="text-2xl font-bold">Client</h1>
      <p>Shared: {props.sharedConstant}</p>
      <p>Server: {props.message}</p>
    </div>
  )
}

export default Status
