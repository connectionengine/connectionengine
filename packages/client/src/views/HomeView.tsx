import type { Component } from 'solid-js'
import Status from '../components/Status'

interface HomeViewProps {
  serverMessage: string
}

/**
 * The view for the Home page.
 * Displays the status component with data provided by the parent.
 */
const HomeView: Component<HomeViewProps> = (props) => {
  return (
    <>
      <Status message={props.serverMessage} sharedConstant="connectionengine" />
    </>
  )
}

export default HomeView
