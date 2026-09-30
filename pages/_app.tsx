import type { AppProps } from 'next/app'
import Head from 'next/head'
import '../global.css'

const App = ({ Component, pageProps }: AppProps) => (
  <>
    <Head>
      <title>Rabot</title>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
    </Head>
    <Component {...pageProps} />
  </>
)

export default App
