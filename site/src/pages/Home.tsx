import Hero from '../components/Hero'
import WhyHearth from '../components/WhyHearth'
import CommonsCallout from '../components/CommonsCallout'
import TheCoin from '../components/TheCoin'
import Mining from '../components/Mining'
import Testnet from '../components/Testnet'

export default function Home() {
  return (
    <>
      <Hero />
      <div className="seam" />
      <WhyHearth />
      <CommonsCallout />
      <div className="seam" />
      <TheCoin />
      <div className="seam" />
      <Mining />
      <div className="seam" />
      <Testnet />
    </>
  )
}
