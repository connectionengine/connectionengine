import { SHARED_CONSTANT } from '@template/core'
import type { Component } from 'solid-js'
import Status from '../components/Status'

interface HomeViewProps {
  serverMessage: string
}

const HomeView: Component<HomeViewProps> = (props) => {
  return (
    <>
      <Status message={props.serverMessage} sharedConstant={SHARED_CONSTANT} />
    </>
  )
}

export default HomeView
