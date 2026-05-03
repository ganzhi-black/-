export default function ProgressDots({ total, current }) {
  return (
    <div className="progress-dots" aria-label={`第 ${current + 1} 题，共 ${total} 题`}>
      {Array.from({ length: total }).map((_, index) => (
        <span key={index} className={index <= current ? "active" : ""} />
      ))}
    </div>
  );
}
