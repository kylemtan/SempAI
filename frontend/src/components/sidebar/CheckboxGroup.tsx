interface Props {
  options: string[];
  selected: string[];
  onToggle: (value: string) => void;
}

export default function CheckboxGroup({ options, selected, onToggle }: Props) {
  return (
    <div className="checkbox-group">
      {options.map((opt) => (
        <label key={opt} className="checkbox-item">
          <input
            type="checkbox"
            checked={selected.includes(opt)}
            onChange={() => onToggle(opt)}
          />
          <span>{opt}</span>
        </label>
      ))}
    </div>
  );
}
