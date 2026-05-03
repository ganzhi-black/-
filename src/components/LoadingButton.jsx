export default function LoadingButton({ loading, children, className = "", ...props }) {
  return (
    <button className={`${className} ${loading ? "is-loading" : ""}`} disabled={loading || props.disabled} {...props}>
      {loading ? <span className="spinner" aria-hidden="true" /> : null}
      <span>{children}</span>
    </button>
  );
}
