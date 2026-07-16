export default function NotFound() {
  return (
    <div className="subpage not-found">
      <p className="eyebrow">404</p>
      <h1>Page not found.</h1>
      <p>The URL may be wrong, or the page may have moved.</p>
      <a className="button primary" href="/">Go to the homepage</a>
    </div>
  );
}
