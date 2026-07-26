import { Link } from 'react-router-dom'

export default function NotFound() {
  return (
    <section className="section">
      <div className="shell flex min-h-[50vh] flex-col items-center justify-center text-center">
        <p className="eyebrow">Error · 404</p>
        <h1 className="display mt-4 text-[clamp(3rem,10vw,6rem)] text-ember-wash">Cold ashes.</h1>
        <p className="mt-4 max-w-md text-ash-dim">
          There’s nothing burning here. The page you were looking for has gone out — let’s get you back to the fire.
        </p>
        <Link to="/" className="btn btn-ember mt-8">
          Back to Hearth
        </Link>
      </div>
    </section>
  )
}
