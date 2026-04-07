interface Props {
  content: string;
}

export function StreamingBubble({ content }: Props) {
  if (!content) return null;

  return (
    <div className="bubble-row bubble-row--assistant">
      <div className="bubble bubble--assistant bubble--streaming">
        <p className="bubble__text">{content}</p>
        <span className="bubble__cursor" />
      </div>
    </div>
  );
}
