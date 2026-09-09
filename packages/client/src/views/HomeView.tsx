import type { Component } from 'solid-js'
import Status from '../components/Status'

interface HomeViewProps {
  serverMessage: string
}

/**
 * The view of the Home page. It shows the status component, with the data that
 * the parent supplies.
 */
const HomeView: Component<HomeViewProps> = (props) => {
  return (
    <>
      <Status message={props.serverMessage} sharedConstant="connectionengine" />
    </>
  )
}

export default HomeView
