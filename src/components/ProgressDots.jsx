export default function ProgressDots({ total, current }) {
  const percent = total ? Math.round(((current + 1) / total) * 100) : 0;

  if (total > 20) {
    return (
      <div className="progress-compact" aria-label={`第 ${current + 1} 题，共 ${total} 题`}>
        <div className="progress-track">
          <span style={{ width: `${percent}%` }} />
        </div>
        <strong>{percent}%</strong>
      </div>
    );
  }

  return (
    <div className="progress-dots" aria-label={`第 ${current + 1} 题，共 ${total} 题`}>
      {Array.from({ length: total }).map((_, index) => (
        <span key={index} className={index <= current ? "active" : ""} />
      ))}
    </div>
  );
}
