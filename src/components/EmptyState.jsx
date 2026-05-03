import { ArrowRight, FileText } from "lucide-react";
import { Link } from "react-router-dom";

export default function EmptyState({ title, description, actionText, to }) {
  return (
    <section className="empty-state">
      <div className="empty-illustration" aria-hidden="true">
        <FileText size={44} />
        <span />
      </div>
      <h2>{title}</h2>
      <p>{description}</p>
      {to && (
        <Link className="primary-button" to={to}>
          {actionText}
          <ArrowRight size={18} />
        </Link>
      )}
    </section>
  );
}
